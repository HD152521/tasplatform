/**
 * 앱 로그아웃.
 *
 * ⚠ **`/api/logout` 과 다른 것이다.** 그쪽은 브로드컴 포털 세션 파일을 지워 수집기를
 * 재로그인 상태로 만든다. 이쪽은 이 브라우저의 사람 세션만 끊는다. 이름이 비슷해
 * 섞이기 쉬우므로 두 파일 머리말에 같은 경고를 둔다.
 *
 * 쿠키를 지우는 것만으로 끝내지 않고 DB 의 세션을 **해지**한다 — 쿠키 값이 이미
 * 어딘가에 복사돼 있으면 쿠키 삭제는 아무 효과가 없다.
 */
import { NextResponse } from "next/server";
import { revokeUserSession } from "../../../../lib/appSession.ts";
import { sessionTokenFromRequest, userFromRequestWith } from "../../../../lib/appAuth.ts";
import { openDb, recordAudit } from "../../../../lib/db.ts";
import { clearSessionCookie } from "../cookie.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const token = sessionTokenFromRequest(request);
  const db = await openDb();
  try {
    const user = await userFromRequestWith(db, request);
    await revokeUserSession(db, token);
    if (user !== null) {
      await recordAudit(db, {
        actor: `${user.displayName}(${user.loginId})`,
        teamId: user.teamId,
        action: "user_signout",
        requestId: null,
        result: "ok",
        detail: "",
      });
    }
  } catch {
    // 해지 실패도 쿠키는 지운다 — 사람 입장에서는 "로그아웃됐다" 가 맞다.
  } finally {
    await db.close();
  }

  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response, request);
  return response;
}
