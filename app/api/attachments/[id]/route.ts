/**
 * 첨부 다운로드.
 *
 * **여기서 직접 받지 않는다.** 첨부는 supportftp(CrushFTP)에 있고, 그 로그인은
 * redirect.html 이 JS 로 이동시켜 끝난다 — fetch 로는 인증 자체가 안 된다.
 * 예전에는 그걸 모르고 여기서 받아 보려다 로그인 화면(HTML)을 첨부 이름으로 저장해,
 * 화면에서 "사용할 수 없는 파일" 이 됐다.
 *
 * 그래서 브라우저가 있는 수집기 VM 에 일을 맡긴다(attachment_jobs). 여기서는 일을
 * 넣고 기다렸다가 받아온 내용을 흘려보낸다. 처음 한 번은 수십 초가 걸린다 —
 * 수집기가 집어가는 데 최대 15초, 브라우저 진입에 10초.
 *
 * **다만 우리가 올린 첨부는 우리 사본으로 바로 준다.** 올린 파일은 supportftp 에 남지
 * 않으므로(files_from_customer 는 투입구다 — lib/attachmentJobs.ts 머리말) 수집기에
 * 맡겨도 404 만 돌아온다. 우리가 올릴 때 남겨 둔 payload 가 유일한 사본이고, 그건 이
 * 자리에서 DB 로 꺼낼 수 있다 — 브라우저도 세션도 필요 없고 기다릴 이유도 없다.
 */
import { NextResponse } from "next/server";
import { API_ORIGIN } from "../../../../lib/config.ts";
import { getAttachment } from "../../../../lib/queries.ts";
import { resolveAttachmentUrl } from "../../../../lib/attachmentSource.ts";
import { hasTeamSession, resolveActorTeam } from "../../../../lib/requestAudit.ts";
import { hydrateTeamSessionFromDb } from "../../../../lib/sessionStore.ts";
import { openDb } from "../../../../lib/db.ts";
import {
  enqueueDownload,
  findKeptUpload,
  getJobPayload,
  getJobStatus,
} from "../../../../lib/attachmentJobs.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 수집기가 받아올 때까지 기다린다. WAIT_MS 보다 넉넉해야 기다리는 도중에 잘리지 않는다.
export const maxDuration = 180;

/**
 * 수집기가 받아올 때까지 기다리는 상한.
 *
 * 집어가는 데 최대 15초(worker 확인 주기), 브라우저 진입에 10초, 파일 받는 데 몇 초.
 * 넉넉히 두되 무한정 붙잡지는 않는다 — 사람이 앞에서 기다린다.
 */
const WAIT_MS = 120_000;
/** 얼마나 자주 확인할지. */
const POLL_MS = 1_500;

/**
 * 어디서 받은 것인지 화면에 알려주는 헤더.
 *
 * 같은 원본(fetch)으로 내려가므로 본문만 보면 구분이 안 된다. 사람에게는 차이가 있다 —
 * 우리 사본은 우리가 보낸 파일이고 supportftp 에는 이미 없다. AttachmentLink 가 이 값을
 * 읽어 한 줄로 알려준다.
 */
const SOURCE_HEADER = "X-Attachment-Source";

/**
 * 우리가 올려 둔 사본을 그 자리에서 꺼낸다. 없으면 null.
 *
 * 짝은 케이스 번호 + 파일 이름으로 맞춘다(findKeptUpload 주석에 같은 이름이 여러 번
 * 올라간 경우의 규칙이 있다).
 */
async function readOurCopy(requestId: number, fileName: string): Promise<string | null> {
  const db = await openDb();
  try {
    const kept = await findKeptUpload(db, { requestId, fileName });
    return kept === null ? null : kept.payload;
  } finally {
    await db.close();
  }
}

/**
 * 받아 온 바이트를 파일로 흘려보낸다.
 *
 * 저장된 content_type 을 우선한다. 여기 닿은 것은 이미 파일이므로 로그인 화면인지 가릴
 * 필요가 없다 — 그 판정은 받아오는 쪽(수집기)에서 이미 했고, 우리 사본은 애초에 우리가
 * 올린 바이트다.
 */
function fileResponse(
  // Buffer<ArrayBuffer> 로 좁힌다. 그냥 Buffer 는 ArrayBufferLike 라 Response 본문으로
  // 받아 주지 않는다(SharedArrayBuffer 일 수 있어서다).
  bytes: Buffer<ArrayBuffer>,
  doc: { doc_name: string; content_type: string },
  documentId: number,
  source: "ours" | "portal",
): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": doc.content_type !== "" ? doc.content_type : "application/octet-stream",
      "Content-Disposition": contentDisposition(doc.doc_name || `attachment-${documentId}`),
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, no-store",
      [SOURCE_HEADER]: source,
    },
  });
}

/**
 * 수집기에 일을 맡기고 결과를 기다린다. 받아온 내용(base64)을 돌려준다.
 *
 * 같은 첨부가 이미 대기·처리 중이면 그 일을 함께 기다린다(enqueueDownload 가 합친다).
 * 브라우저 한 번 띄우는 데 10초라, 여러 사람이 같은 파일을 눌러도 한 번만 받아온다.
 */
async function fetchViaWorker(
  documentId: number,
  requestId: number,
  fileName: string,
): Promise<string> {
  const db = await openDb();
  try {
    const jobId = await enqueueDownload(db, { documentId, requestId, fileName });
    const deadline = Date.now() + WAIT_MS;

    for (;;) {
      const status = await getJobStatus(db, jobId);
      if (status === null) throw new Error("첨부 작업이 사라졌습니다. 다시 시도하세요.");
      if (status.state === "failed") throw new Error(status.error || "첨부를 가져오지 못했습니다.");
      if (status.state === "done") {
        const full = await getJobPayload(db, jobId);
        if (full === null || full.payload === "") {
          // 치워진 뒤에 물어본 경우다. 다시 요청하면 받아온다.
          throw new Error("받아 둔 내용이 사라졌습니다. 다시 시도하세요.");
        }
        return full.payload;
      }
      if (Date.now() > deadline) {
        throw new Error(
          "수집기가 첨부를 가져오는 데 시간이 오래 걸립니다. 잠시 후 다시 눌러 주세요.",
        );
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } finally {
    await db.close();
  }
}

/** 한글 등 비 ASCII 파일명을 안전하게 붙인다(RFC 5987). */
function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "download";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const documentId = Number(id);
  if (!Number.isInteger(documentId) || documentId <= 0) {
    return NextResponse.json({ ok: false, message: "잘못된 첨부 id 입니다." }, { status: 400 });
  }

  // team 은 쿼리로 받는다(?team=). 형식이 잘못됐을 때만 걸러지고, 없으면 기본 팀.
  const url = new URL(request.url);
  const actorTeam = resolveActorTeam({ team: url.searchParams.get("team") ?? undefined });
  if (!actorTeam.ok) {
    return NextResponse.json({ ok: false, message: actorTeam.message }, { status: 400 });
  }
  const { teamId } = actorTeam;

  const doc = await getAttachment(documentId);
  if (doc === null) {
    return NextResponse.json({ ok: false, message: "첨부를 찾을 수 없습니다." }, { status: 404 });
  }

  // 우리가 올린 첨부라면 우리 사본으로 그 자리에서 내려준다.
  //
  // 수집기에 맡겨도 받을 수 없는 파일이다 — files_from_customer 는 투입구라 Broadcom 이
  // 가져가면 비워지고, 그다음부터는 404 다(lib/attachmentJobs.ts 머리말). 원본 경로도
  // 세션도 쓰지 않으므로 아래 두 판정보다 **앞에서** 처리한다. 수십 초를 기다릴 이유도 없다.
  const ours = await readOurCopy(doc.request_id, doc.doc_name);
  if (ours !== null) {
    return fileResponse(Buffer.from(ours, "base64"), doc, documentId, "ours");
  }

  const source = resolveAttachmentUrl(doc.doc_path, API_ORIGIN);
  if (source === null) {
    return NextResponse.json(
      { ok: false, message: "이 첨부에는 다운로드 가능한 원본 경로가 없습니다." },
      { status: 404 },
    );
  }

  // 재시작으로 로컬 세션 파일이 없을 수 있으니 DB 백업에서 먼저 복원한다.
  await hydrateTeamSessionFromDb(teamId);
  if (!hasTeamSession(teamId)) {
    return NextResponse.json(
      { ok: false, code: "session", message: "세션이 없습니다. SR 페이지에서 로그인하세요." },
      { status: 401 },
    );
  }

  // 첨부는 수집기(브라우저가 있는 기계)가 받아 온다.
  //
  // 여기서 직접 받을 수 없다. supportftp 의 로그인은 redirect.html 이 **JS 로** 이동시켜
  // 끝나므로 fetch 로는 인증 자체가 안 된다. 예전에는 그걸 모르고 여기서 받아 보려다
  // 로그인 화면(HTML)을 파일로 저장해, 화면에서 "사용할 수 없는 파일" 이 됐다.
  let payload: string;
  try {
    payload = await fetchViaWorker(documentId, doc.request_id, doc.doc_name);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 화면이 fetch 로 받아 이 메시지를 그 자리에 보여준다(AttachmentLink).
    // 예전처럼 Broadcom 으로 튕겨 보내지 않는다 — 자동으로 받아오는 것이 이 기능의 목적이다.
    return NextResponse.json({ ok: false, message }, { status: 502 });
  }

  return fileResponse(Buffer.from(payload, "base64"), doc, documentId, "portal");
}
