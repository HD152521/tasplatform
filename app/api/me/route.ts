/**
 * 내 계정 — 이름·비밀번호·Jira 계정 연결.
 *
 * 대상은 **항상 세션의 사용자**다. 본문에서 userId 를 받지 않는다 — 받으면
 * "남의 비밀번호를 바꾸는 주소" 가 하나 생긴다.
 */
import { NextResponse } from "next/server";
import { userFromRequestWith } from "../../../lib/appAuth.ts";
import { revokeAllUserSessions } from "../../../lib/appSession.ts";
import { openDb, recordAudit } from "../../../lib/db.ts";
import {
  SignupError,
  authenticate,
  setDisplayName,
  setJiraAccountId,
  setPassword,
} from "../../../lib/users.ts";
import { clearSessionCookie } from "../auth/cookie.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, message: "요청 본문을 읽지 못했습니다." }, { status: 400 });
  }
  const action = typeof body.action === "string" ? body.action : "";
  const str = (key: string): string => (typeof body[key] === "string" ? (body[key] as string) : "");

  const db = await openDb();
  try {
    const me = await userFromRequestWith(db, request);
    if (me === null) {
      return NextResponse.json({ ok: false, message: "로그인이 필요합니다." }, { status: 401 });
    }
    const actor = `${me.displayName}(${me.loginId})`;

    switch (action) {
      case "display_name": {
        await setDisplayName(db, me.userId, str("displayName"));
        return NextResponse.json({ ok: true, displayName: str("displayName").trim() });
      }

      case "jira_account": {
        const accountId = str("jiraAccountId");
        await setJiraAccountId(db, me.userId, accountId);
        await recordAudit(db, {
          actor, teamId: me.teamId, action: "user_jira_link", requestId: null,
          result: "ok", detail: accountId === "" ? "cleared" : "set",
        });
        return NextResponse.json({ ok: true, jiraAccountId: accountId.trim() });
      }

      case "password": {
        // 지금 비밀번호를 반드시 확인한다. 세션만으로 비밀번호를 바꿀 수 있으면
        // 남이 잠깐 앉은 브라우저로 계정을 가져갈 수 있다.
        const current = str("currentPassword");
        if ((await authenticate(db, me.loginId, current)) === null) {
          return NextResponse.json(
            { ok: false, message: "지금 비밀번호가 맞지 않습니다." },
            { status: 400 },
          );
        }
        await setPassword(db, me.userId, str("newPassword"));
        // 비밀번호를 바꾸면 **모든 세션을 끊는다**(이 브라우저까지). 바꾸는 이유가
        // "누가 봤을지도 모른다" 인 경우가 많고, 그때 다른 기기의 세션이 남으면
        // 바꾼 의미가 없다. 그래서 쿠키도 지우고 다시 로그인하게 한다.
        await revokeAllUserSessions(db, me.userId);
        await recordAudit(db, {
          actor, teamId: me.teamId, action: "user_password_change", requestId: null,
          result: "ok", detail: "",
        });
        const response = NextResponse.json({
          ok: true,
          signedOut: true,
          message: "비밀번호를 바꿨습니다. 모든 기기에서 로그아웃되었으니 다시 로그인해 주세요.",
        });
        clearSessionCookie(response, request);
        return response;
      }

      default:
        return NextResponse.json({ ok: false, message: `모르는 동작입니다: ${action}` }, { status: 400 });
    }
  } catch (error) {
    if (error instanceof SignupError) {
      return NextResponse.json({ ok: false, message: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  } finally {
    await db.close();
  }
}
