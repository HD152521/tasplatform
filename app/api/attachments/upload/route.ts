/**
 * 첨부 올리기.
 *
 * **여기서 직접 올리지 않는다.** 첨부는 포털이 아니라 supportftp(CrushFTP)로 가고,
 * 그 로그인은 redirect.html 이 302 가 아니라 **JS 로** 이동시켜 끝난다 — fetch 로는
 * 인증 자체가 안 된다(lib/crushftp.ts 머리말). 그래서 브라우저가 있는 수집기 VM 에
 * 일을 맡긴다(attachment_jobs). 받아오는 쪽과 대칭이다(app/api/attachments/[id]).
 *
 * ## 왜 기다리지 않고 바로 돌려주나
 *
 * 예전에는 POST 하나가 **수집기가 올릴 때까지 최대 120초를 붙잡고** 있었다. 그 사이
 * 요청은 바이트 한 개도 오가지 않는 상태로 열려 있는데, 그 길에는 VPN 과 TAS 라우터가
 * 있다. 조용한 연결은 끊긴다 — 실제로 담당자는 **10~20초 만에 "fetch 실패"** 를 봤다.
 * 파일은 큐에 멀쩡히 들어가 수집기가 올렸는데도 화면은 실패라고 말했고, 그러면 사람은
 * 다시 올려 케이스에 같은 파일이 두 번 붙는다.
 *
 * 그래서 둘로 나눈다.
 *   POST  파일을 받아 큐에 넣고 **즉시** job 번호를 돌려준다(202).
 *   GET   그 job 이 끝났는지 묻는다. 한 번에 1초도 안 걸린다.
 *
 * 긴 연결이 사라지므로 중간에서 끊길 자리가 없다. 확인이 한 번 실패해도 다시 물으면
 * 되고(일은 큐에 그대로 있다), 창을 닫아도 수집기는 올린다.
 *
 * ## 감사 로그
 *
 * 올리기의 **결과**는 이제 수집기가 안다. 그래서 여기서는 "큐에 넣었다(queued)" 까지만
 * 남기고, 성공/실패 한 줄은 수집기가 남긴다(collector/attachments.ts). 확인(GET)은
 * 남기지 않는다 — 조회를 남기면 로그가 조회로 덮인다.
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
// 파일을 받아 큐에 넣는 것까지다. 더 기다리지 않으므로 긴 상한이 필요 없다.
export const maxDuration = 60;

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

  const db = await openDb();
  let jobId: number;
  try {
    jobId = await enqueueUpload(db, { requestId, fileName, payload, actor, teamId });
  } catch (error) {
    // 여기 닿는 것은 DB 자체가 안 열리는 등 진짜 예상 못한 오류뿐이다.
    // 파일 내용은 절대 담지 않는다 — 메시지만 흘린다.
    const message = error instanceof Error ? error.message : String(error);
    await recordWriteAudit({ actor, teamId, action: "upload", requestId, result: "failed:error" });
    return NextResponse.json({ ok: false, message }, { status: 500 });
  } finally {
    await db.close();
  }

  await recordWriteAudit({
    actor, teamId, action: "upload", requestId, result: "queued", detail: fileName,
  });

  // 202: 받았고 아직 안 끝났다. 끝났는지는 아래 GET 으로 묻는다.
  return NextResponse.json(
    { ok: true, jobId, state: "pending", message: `${fileName} 을 줄에 세웠습니다.` },
    { status: 202 },
  );
}

/**
 * 올리기 한 건이 끝났는지 알려준다.
 *
 * ## 누가 물을 수 있나
 *
 * `job_id` 는 팀·케이스를 통틀어 **1씩 늘어나는 정수**다. 그래서 번호만으로는
 * 울타리가 되지 않는다 — 작은 수를 차례로 넣어 보면 남의 올리기 상태와 파일 이름,
 * 실패 사유를 훑을 수 있다. 세 겹으로 막는다.
 *
 *   1. 세션이 있어야 한다(ensureTeamSession). 쓰기 경로와 같은 문턱이다.
 *   2. `requestId` 가 그 일의 케이스와 같아야 한다.
 *   3. 그 일의 팀이 묻는 팀과 같아야 한다.
 *
 * 옛 행은 team_id 가 빈 문자열이다(이 칸이 생기기 전에 들어간 것). 그때는 팀을
 * 따지지 않는다 — 막으면 그 일들의 상태를 아무도 못 묻게 되고, 그건 중복 업로드를
 * 부른다. 이 글을 쓰는 시점에 팀은 하나다.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const jobId = Number(url.searchParams.get("job"));
  const requestId = Number(url.searchParams.get("requestId"));
  if (!Number.isInteger(jobId) || jobId <= 0 || !Number.isInteger(requestId) || requestId <= 0) {
    return NextResponse.json({ ok: false, message: "잘못된 요청입니다." }, { status: 400 });
  }

  const actorTeam = resolveActorTeam({ team: url.searchParams.get("team") ?? undefined });
  if (!actorTeam.ok) {
    return NextResponse.json({ ok: false, message: actorTeam.message }, { status: 400 });
  }
  const { teamId } = actorTeam;
  // 조회라 감사 로그는 남기지 않는다(audit 인자를 주지 않는다).
  const noSession = await ensureTeamSession(teamId);
  if (noSession !== null) return noSession;

  const db = await openDb();
  try {
    const status = await getJobStatus(db, jobId);
    if (
      status === null
      || status.request_id !== requestId
      || status.kind !== "upload"
      || (status.team_id !== "" && status.team_id !== teamId)
    ) {
      return NextResponse.json(
        { ok: false, message: "첨부 작업을 찾을 수 없습니다." },
        { status: 404 },
      );
    }
    if (status.state === "failed") {
      return NextResponse.json({
        ok: true, state: "failed",
        message: status.error || "첨부를 올리지 못했습니다.",
      });
    }
    if (status.state === "done") {
      return NextResponse.json({
        ok: true, state: "done", message: `${status.file_name} 을 올렸습니다.`,
      });
    }
    return NextResponse.json({ ok: true, state: status.state });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[api/attachments/upload] 상태 확인 실패", error);
    return NextResponse.json({ ok: false, message }, { status: 500 });
  } finally {
    await db.close();
  }
}
