/**
 * 첨부 올리기.
 *
 * **여기서 직접 올리지 않는다.** 첨부는 포털이 아니라 supportftp(CrushFTP)로 가고,
 * 그 로그인은 redirect.html 이 302 가 아니라 **JS 로** 이동시켜 끝난다 — fetch 로는
 * 인증 자체가 안 된다(lib/crushftp.ts 머리말). 그래서 브라우저가 있는 수집기 VM 에
 * 일을 맡긴다(attachment_jobs). 받아오는 쪽과 대칭이다(app/api/attachments/[id]).
 *
 * 여기서 하는 일은 셋뿐이다: 받아도 되는 요청인지 판정하고, 큐에 넣고, 결과를 기다린다.
 * 기다리는 이유는 사람이 화면 앞에 있기 때문이다 — "올렸다/못 올렸다" 를 그 자리에서
 * 말해 주지 않으면 사람은 같은 파일을 다시 올려 케이스에 중복 첨부가 생긴다.
 *
 * 파일 내용은 어디에도 로그로 남기지 않는다. 고객 파일이다.
 */
import { NextResponse } from "next/server";
import { getCase, isClosedStatus } from "../../../../lib/queries.ts";
import { ensureTeamSession, recordWriteAudit, resolveActorTeam } from "../../../../lib/requestAudit.ts";
import { openDb } from "../../../../lib/db.ts";
import { enqueueUpload, getJobStatus } from "../../../../lib/attachmentJobs.ts";
import {
  MAX_UPLOAD_BYTES,
  TOO_LARGE_MESSAGE,
  checkUploadRequest,
} from "../../../../lib/attachmentUpload.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 수집기가 올릴 때까지 기다린다. WAIT_MS 보다 넉넉해야 기다리는 도중에 잘리지 않는다.
export const maxDuration = 180;

/**
 * 수집기가 올릴 때까지 기다리는 상한.
 *
 * 집어가는 데 최대 15초(worker 확인 주기), 브라우저로 케이스에 진입하는 데 10초,
 * 조각을 올리는 데 몇 초. 받아오는 쪽과 같은 값으로 둔다 — 같은 수집기, 같은 대기다.
 */
const WAIT_MS = 120_000;
/** 얼마나 자주 확인할지. */
const POLL_MS = 1_500;

type WaitOutcome =
  | { state: "done" }
  | { state: "failed"; message: string }
  | { state: "slow"; message: string };

/**
 * 큐에 넣고 결과를 기다린다.
 *
 * 상한을 넘겨도 **실패로 부르지 않는다**. 일은 큐에 그대로 남아 있고 수집기가 결국
 * 올린다 — 여기서 "실패" 라고 말하면 사람이 다시 올려 케이스에 같은 파일이 두 번 붙는다.
 * 그래서 "아직 처리 중" 으로 구분해 돌려준다.
 */
async function uploadViaWorker(
  requestId: number,
  fileName: string,
  payload: string,
  actor: string,
): Promise<WaitOutcome> {
  const db = await openDb();
  try {
    const jobId = await enqueueUpload(db, { requestId, fileName, payload, actor });
    const deadline = Date.now() + WAIT_MS;

    for (;;) {
      const status = await getJobStatus(db, jobId);
      if (status === null) {
        return { state: "failed", message: "첨부 작업이 사라졌습니다. 다시 시도하세요." };
      }
      if (status.state === "failed") {
        return { state: "failed", message: status.error || "첨부를 올리지 못했습니다." };
      }
      if (status.state === "done") return { state: "done" };
      if (Date.now() > deadline) {
        return {
          state: "slow",
          message:
            "수집기가 아직 올리는 중입니다. 다시 올리지 말고 잠시 후 케이스를 새로고침해 확인하세요.",
        };
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } finally {
    await db.close();
  }
}

/**
 * multipart 경계·필드 이름이 붙으므로 본문은 파일보다 조금 크다. 여유분.
 */
const ENVELOPE_SLACK = 64 * 1024;

export async function POST(request: Request): Promise<Response> {
  // 파싱하기 **전에** 길이부터 본다. formData() 는 본문을 통째로 메모리에 올리므로,
  // 크기 판정을 그 뒤에 하면 거절할 파일도 일단 다 받아 놓는 꼴이 된다.
  // Content-Length 는 없을 수도 있고(청크 전송) 거짓일 수도 있으니, 이건 방어일 뿐
  // 진짜 판정은 아래 checkUploadRequest 가 file.size 로 한다.
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + ENVELOPE_SLACK) {
    return NextResponse.json({ ok: false, message: TOO_LARGE_MESSAGE }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, message: "잘못된 요청입니다." }, { status: 400 });
  }

  // 답변 쓰기와 같은 순서·같은 하위호환으로 처리한다(app/api/reply/route.ts):
  // team 이 없으면 기본 팀, actor 가 없으면 빈 문자열. 형식이 잘못됐을 때만 걸린다.
  const actorTeam = resolveActorTeam({
    actor: form.get("actor") ?? undefined,
    team: form.get("team") ?? undefined,
  });
  if (!actorTeam.ok) {
    return NextResponse.json({ ok: false, message: actorTeam.message }, { status: 400 });
  }
  const { actor, teamId } = actorTeam;

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, message: "올릴 파일이 없습니다." }, { status: 400 });
  }
  const check = checkUploadRequest({
    requestId: form.get("requestId"),
    fileName: file.name,
    size: file.size,
  });
  if (!check.ok) {
    // 상한 초과는 감사 로그에 남긴다 — 사람들이 큰 파일을 이 경로로 올리려 한다면
    // 상한이 틀린 것이고, 그 사실은 로그에만 남는다.
    if (check.code === "too_large") {
      await recordWriteAudit({
        actor, teamId, action: "upload", requestId: Number(form.get("requestId")) || null,
        result: "failed:too_large",
      });
    }
    return NextResponse.json({ ok: false, message: check.message }, { status: 400 });
  }
  const { requestId, fileName } = check;

  // 재시작으로 로컬 세션 파일이 없을 수 있으니 DB 백업에서 먼저 복원한다(hasTeamSession 전).
  const noSession = await ensureTeamSession(teamId, { actor, action: "upload", requestId });
  if (noSession !== null) return noSession;

  // 종료된 케이스에는 올리지 않는다. 답변과 같은 판정을 쓴다.
  const detail = await getCase(requestId);
  if (detail === null) {
    await recordWriteAudit({ actor, teamId, action: "upload", requestId, result: "failed:not_found" });
    return NextResponse.json({ ok: false, message: "케이스를 찾을 수 없습니다." }, { status: 404 });
  }
  if (isClosedStatus(detail.status)) {
    await recordWriteAudit({ actor, teamId, action: "upload", requestId, result: "failed:closed" });
    return NextResponse.json(
      { ok: false, message: "종료된 케이스에는 첨부를 올릴 수 없습니다." },
      { status: 400 },
    );
  }

  // base64 로 큐에 넣는다. SQLite BLOB 과 Postgres BYTEA 를 가르지 않으려는 것이다
  // (lib/attachmentJobs.ts). 일이 끝나면 수집기가 payload 를 비운다.
  const payload = Buffer.from(await file.arrayBuffer()).toString("base64");

  let outcome: WaitOutcome;
  try {
    outcome = await uploadViaWorker(requestId, fileName, payload, actor);
  } catch (error) {
    // 여기 닿는 것은 DB 자체가 안 열리는 등 진짜 예상 못한 오류뿐이다.
    // 파일 내용은 절대 담지 않는다 — 메시지만 흘린다.
    const message = error instanceof Error ? error.message : String(error);
    await recordWriteAudit({ actor, teamId, action: "upload", requestId, result: "failed:error" });
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }

  if (outcome.state === "done") {
    await recordWriteAudit({
      actor, teamId, action: "upload", requestId, result: "ok", detail: fileName,
    });
    return NextResponse.json({ ok: true, message: `${fileName} 을 올렸습니다.` });
  }

  await recordWriteAudit({
    actor, teamId, action: "upload", requestId,
    result: outcome.state === "slow" ? "failed:timeout" : "failed:upload",
    detail: fileName,
  });
  // 아직 처리 중인 것(slow)은 200 으로 돌려주지 않는다 — 버튼이 성공으로 읽으면
  // 사람은 올라간 줄 안다. 다만 문구로 "다시 올리지 말라" 고 구분해 말한다.
  return NextResponse.json({ ok: false, message: outcome.message }, { status: 409 });
}
