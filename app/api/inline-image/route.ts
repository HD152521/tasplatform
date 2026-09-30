import { NextResponse } from "next/server";
import { CookieJar } from "../../../collector/cookieJar.ts";
import { API_HEADERS, API_ORIGIN, sessionFileForTeam } from "../../../lib/config.ts";
import { isFileId } from "../../../lib/inlineImages.ts";
import { ensureTeamSession, resolveActorTeam } from "../../../lib/requestAudit.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 답변 본문에 박혀 온 이미지를 서버가 세션으로 대신 받아 내려준다.
 *
 * 화면에서 그 주소를 그대로 `<img src>` 에 걸 수 없다. 브라우저에는 포털 세션이 없어
 * 401 이 오고 깨진 그림이 된다. 그래서 여기를 거친다.
 *
 * 첨부(supportftp)와 달리 **브라우저도 작업 큐도 필요 없다.** 이 이미지는 우리가 평소에
 * 케이스를 읽는 포털 API 에 있고, 세션 쿠키로 바로 받아진다.
 *
 * ## 주소를 받지 않고 id 만 받는다
 *
 * 클라이언트가 준 URL 로 서버가 대리 요청을 보내면 열린 프록시가 된다. 여기서는 id 만
 * 받아 **주소를 우리가 만든다.** 호스트가 고정되므로 엉뚱한 곳으로 나갈 수 없다.
 */

/** 이미지가 바뀌지 않으므로 한 번 받으면 브라우저가 들고 있게 둔다. */
const CACHE = "private, max-age=3600";

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!isFileId(id)) {
    return NextResponse.json({ ok: false, message: "이미지를 알 수 없습니다." }, { status: 400 });
  }

  const actorTeam = resolveActorTeam({});
  if (!actorTeam.ok) {
    return NextResponse.json({ ok: false, message: actorTeam.message }, { status: 400 });
  }
  const { teamId } = actorTeam;

  const noSession = await ensureTeamSession(teamId);
  if (noSession !== null) return noSession;

  const target = new URL(`${API_ORIGIN}/attachment/get_attachment_content`);
  target.searchParams.set("uniqueFileId", id);

  const jar = CookieJar.fromFile(sessionFileForTeam(teamId));
  const cookie = jar.header(target);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      headers: { ...API_HEADERS, ...(cookie === "" ? {} : { Cookie: cookie }) },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, message }, { status: 502 });
  }

  if (upstream.status === 401) {
    return NextResponse.json(
      { ok: false, code: "session", message: "세션이 만료되었습니다." },
      { status: 401 },
    );
  }
  if (!upstream.ok) {
    return NextResponse.json(
      { ok: false, message: `이미지를 가져오지 못했습니다 (HTTP ${upstream.status}).` },
      { status: 502 },
    );
  }

  const type = (upstream.headers.get("content-type") ?? "").toLowerCase();
  // 세션이 없으면 포털이 200 으로 로그인 화면이나 JSON 오류를 준다. 그걸 이미지라고
  // 내려보내면 화면에 깨진 그림만 남고 이유를 알 수 없다.
  if (!type.startsWith("image/")) {
    return NextResponse.json(
      { ok: false, message: "이미지가 아니라 다른 응답이 왔습니다. 세션을 확인하세요." },
      { status: 502 },
    );
  }

  const body = await upstream.arrayBuffer();
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(body.byteLength),
      "Cache-Control": CACHE,
    },
  });
}
