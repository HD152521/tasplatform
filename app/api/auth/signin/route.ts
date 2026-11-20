/**
 * 앱 로그인. **브로드컴 포털 로그인(`/api/login/*`)과 다른 것이다** —
 * 이쪽은 "이 브라우저를 쓰는 사람이 누구인가", 저쪽은 공용 계정의 포털 세션이다.
 */
import { NextResponse } from "next/server";
import { createUserSession, purgeExpiredSessions } from "../../../../lib/appSession.ts";
import { openDb, recordAudit } from "../../../../lib/db.ts";
import { authenticate, getUserWithTeam } from "../../../../lib/users.ts";
import { setSessionCookie } from "../cookie.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, message: "요청 본문을 읽지 못했습니다." }, { status: 400 });
  }

  const loginId = typeof body.loginId === "string" ? body.loginId : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (loginId.trim() === "" || password === "") {
    return NextResponse.json({ ok: false, message: "아이디와 비밀번호를 입력해 주세요." }, { status: 400 });
  }

  const db = await openDb();
  try {
    const user = await authenticate(db, loginId, password);
    if (user === null) {
      // 어느 쪽이 틀렸는지 알려주지 않는다(lib/users.ts authenticate 주석).
      await recordAudit(db, {
        actor: loginId.trim().toLowerCase(),
        teamId: "",
        action: "user_signin",
        requestId: null,
        result: "failed:bad_credentials",
        detail: "",
      });
      return NextResponse.json(
        { ok: false, message: "아이디 또는 비밀번호가 맞지 않습니다." },
        { status: 401 },
      );
    }

    const withTeam = await getUserWithTeam(db, user.userId);
    const session = await createUserSession(db, user.userId);
    await purgeExpiredSessions(db).catch(() => 0);
    await recordAudit(db, {
      actor: `${user.displayName}(${user.loginId})`,
      teamId: withTeam?.teamId ?? "",
      action: "user_signin",
      requestId: null,
      result: "ok",
      detail: "",
    });

    const response = NextResponse.json({
      ok: true,
      user: {
        loginId: user.loginId,
        displayName: user.displayName,
        teamId: withTeam?.teamId ?? "",
        role: withTeam?.role ?? "member",
      },
    });
    setSessionCookie(response, request, session.token, session.maxAgeSeconds);
    return response;
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  } finally {
    await db.close();
  }
}
