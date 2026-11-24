import { NextResponse } from "next/server";
import { CookieJar } from "../../../collector/cookieJar.ts";
import { API_HEADERS, API_ORIGIN, sessionFileForTeam } from "../../../lib/config.ts";
import { isDeadSessionResponse, isFileId } from "../../../lib/inlineImages.ts";
import { ensureTeamSession, resolveActorTeam } from "../../../lib/requestAudit.ts";
import { retryOnDeadSession } from "../../../lib/sessionRetry.ts";

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
 *
 * ## 세션이 죽었으면 한 번 다시 받는다
 *
 * 전에는 401 을 그대로 "세션이 만료되었습니다" 로 바꿔 돌려주었다. 그런데 세션은 쿠키
 * 만료 시각 전에도 죽는다 — 계정이 하나라 수집기가 재로그인하면 앞선 세션이 서버 쪽에서
 * 무효가 되고, 쿠키 시각은 여전히 미래다. 그래서 문턱(ensureTeamSession)은 통과하고
 * 여기서 401 이 났다. DB 에는 수집기가 올려 둔 **살아 있는** 세션이 있는데도 쳐다보지
 * 않았으므로, 수집기가 한 번 재로그인하면 케이스를 열 때마다 본문 그림이 전부 깨졌다.
 * 사람이 할 수 있는 일은 없는데 화면은 "로그인하세요" 라고 말했다.
 *
 * 쓰기 경로(create·reply·releases)가 이미 하던 것과 같은 수리다 — 공통 자리는
 * lib/sessionRetry.ts 다.
 */

/** 이미지가 바뀌지 않으므로 한 번 받으면 브라우저가 들고 있게 둔다. */
const CACHE = "private, max-age=3600";

/** 한 번 받아 본 결과. 망 오류는 응답이 아니므로 따로 담는다. */
interface Attempt {
  readonly response: Response | null;
  readonly failure: string;
}

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

  const attempt = await retryOnDeadSession<Attempt>(teamId, {
    // ⚠ 쿠키를 **이 안에서** 읽는다. 바깥에서 한 번 읽어 두면 재시도가 방금 끌어온
    //   새 세션이 아니라 죽은 옛 쿠키를 그대로 또 보낸다.
    send: async () => {
      try {
        const cookie = CookieJar.fromFile(sessionFileForTeam(teamId)).header(target);
        const response = await fetch(target, {
          headers: { ...API_HEADERS, ...(cookie === "" ? {} : { Cookie: cookie }) },
        });
        return { response, failure: "" };
      } catch (error) {
        return {
          response: null,
          failure: error instanceof Error ? error.message : String(error),
        };
      }
    },
    deadSession: ({ response }) =>
      response !== null
      && isDeadSessionResponse(response.status, response.headers.get("content-type")),
    // 버리는 응답의 본문은 닫는다. 안 닫으면 연결이 열린 채 남는다.
    discard: ({ response }) => response?.body?.cancel(),
  });

  if (attempt.response === null) {
    return NextResponse.json({ ok: false, message: attempt.failure }, { status: 502 });
  }
  const upstream = attempt.response;

  if (upstream.status === 401) {
    return NextResponse.json(
      {
        ok: false,
        code: "session",
        // 최신 세션으로 이미 한 번 더 받아 본 뒤다 — 그래도 401 이면 사람이 로그인해야 한다.
        message: "세션이 만료되었습니다. SR 페이지에서 다시 로그인하세요.",
      },
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
