/**
 * 첨부 다운로드 프록시.
 *
 * 그동안 화면의 첨부 링크는 docFullPath 로 바로 이어져, 클릭하면 로그인 세션이 없는
 * 브라우저가 Broadcom 사이트로 튕겨 나갔다(파일이 받아지지 않음). 여기서 서버가 팀
 * 세션 쿠키로 대신 받아, Content-Disposition: attachment 로 그대로 흘려보낸다.
 *
 * 브라우저를 띄우지 않는다(collector/httpClient.ts 의 fetchClient 와 같은 쿠키 방식).
 * 다만 파일은 바이너리라 텍스트로 읽는 fetchClient 대신 CookieJar 로 직접 스트리밍한다.
 */
import { NextResponse } from "next/server";
import { CookieJar } from "../../../../collector/cookieJar.ts";
import { API_HEADERS, API_ORIGIN, sessionFileForTeam } from "../../../../lib/config.ts";
import { getAttachment } from "../../../../lib/queries.ts";
import { isAllowedHost, resolveAttachmentUrl } from "../../../../lib/attachmentSource.ts";
import { hasTeamSession, resolveActorTeam, runSideEffect } from "../../../../lib/requestAudit.ts";
import { hydrateTeamSessionFromDb, persistTeamSessionToDb } from "../../../../lib/sessionStore.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 리다이렉트를 몇 번까지 따라갈지. OAuth 왕복이 서너 번이라 넉넉히 둔다. */
const MAX_HOPS = 8;

/**
 * 쿠키를 들고 리다이렉트를 따라간다.
 *
 * fetch 의 redirect:"follow" 는 쿠키 단지를 모른다. supportftp 는 세션이 없으면
 * access.broadcom.com 으로 OAuth 를 돌고 _codexch 로 돌아오며 **hop 마다 쿠키를
 * 심는다**. 그걸 주고받지 않으면 끝내 로그인 화면이 돌아온다. 그래서 직접 따라가며
 * hop 마다 Cookie 를 붙이고 Set-Cookie 를 단지에 담는다.
 *
 * 따라가는 곳은 허용 호스트로 제한한다 — 열린 리다이렉트를 타고 엉뚱한 곳으로
 * 서버가 대리 요청을 보내면 안 된다.
 */
async function followWithJar(start: string, jar: CookieJar): Promise<Response> {
  let url = start;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const at = new URL(url);
    const cookie = jar.header(at);
    const response = await fetch(url, {
      headers: { ...API_HEADERS, ...(cookie === "" ? {} : { Cookie: cookie }) },
      redirect: "manual",
    });
    jar.apply(response.headers.getSetCookie(), at);

    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location === null) return response;

    const next = new URL(location, at);
    if (next.protocol !== "https:" && next.protocol !== "http:") return response;
    if (!isAllowedHost(next.hostname)) return response;
    url = next.toString();
  }
  throw new Error(`리다이렉트가 ${MAX_HOPS}번을 넘었습니다`);
}

/**
 * 파일을 못 내줄 때는 **원본으로 보낸다**.
 *
 * 오류 본문을 그대로 돌려주면 화면의 <a download> 가 그것을 첨부 이름으로 저장해
 * 열리지 않는 파일이 된다. 차라리 Broadcom 으로 보내면 거기서 로그인하고 받을 수 있다.
 */
function bounce(source: string, why: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: source, "X-Sr-Reason": encodeURIComponent(why) },
  });
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

  const sessionFile = sessionFileForTeam(teamId);
  const jar = CookieJar.fromFile(sessionFile);

  let upstream: Response;
  try {
    upstream = await followWithJar(source, jar);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, message: `첨부를 가져오지 못했습니다: ${message}` },
      { status: 502 },
    );
  }

  // 회전된 세션 쿠키를 반영해 되돌린다(다음 요청 401 방지). 실패해도 다운로드는 막지 않는다.
  await runSideEffect("attachment persist", () => jar.persist(sessionFile));
  await runSideEffect("attachment session→db", () => persistTeamSessionToDb(teamId));

  if (upstream.status === 401) return bounce(source, "세션이 만료되었습니다");
  if (!upstream.ok || upstream.body === null) {
    return bounce(source, `원본 응답 오류 (HTTP ${upstream.status})`);
  }

  // 로그인 페이지를 파일로 저장해 버리는 것을 막는다.
  //
  // supportftp 는 세션이 없으면 OAuth 로 302 를 보내고, 그 끝에서 **HTTP 200 + HTML**
  // 로그인 화면을 준다. 그대로 흘리면 브라우저가 <a download> 때문에 그 HTML 을
  // 첨부 이름으로 저장하고, 열리지 않는 파일이 된다. 첨부 자체가 html 인 경우가
  // 아니라면 여기서 끊는다.
  const upstreamType = (upstream.headers.get("content-type") ?? "").toLowerCase();
  const wantsHtml = doc.content_type.toLowerCase().includes("html")
    || /\.html?$/i.test(doc.doc_name);
  if (!wantsHtml && upstreamType.includes("text/html")) {
    return bounce(source, "Broadcom 로그인이 필요합니다");
  }

  // 저장된 content_type 을 우선하고, 없으면 업스트림 값, 그것도 없으면 범용 바이너리.
  const contentType =
    doc.content_type !== ""
      ? doc.content_type
      : upstream.headers.get("content-type") ?? "application/octet-stream";
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Disposition": contentDisposition(doc.doc_name || `attachment-${documentId}`),
    "Cache-Control": "private, no-store",
  };
  const length = upstream.headers.get("content-length");
  if (length !== null) headers["Content-Length"] = length;

  return new Response(upstream.body, { status: 200, headers });
}
