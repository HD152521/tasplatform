/**
 * 회원가입. 성공하면 그 자리에서 로그인까지 시킨다(쿠키를 심는다).
 *
 * 가입하고 다시 로그인 화면으로 보내면 방금 넣은 비밀번호를 한 번 더 치게 된다.
 * 가입 직후 세션을 주는 것이 자연스럽고, 보안상 달라지는 것도 없다 — 방금 그 사람이
 * 비밀번호를 정했다.
 */
import { NextResponse } from "next/server";
import { createUserSession, purgeExpiredSessions } from "../../../../lib/appSession.ts";
import { openDb, recordAudit } from "../../../../lib/db.ts";
import { SignupError, countUsers, signup } from "../../../../lib/users.ts";
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

  const str = (key: string): string => (typeof body[key] === "string" ? (body[key] as string) : "");

  const db = await openDb();
  try {
    const user = await signup(db, {
      loginId: str("loginId"),
      displayName: str("displayName"),
      password: str("password"),
      inviteCode: str("inviteCode"),
      mode: body.mode === "create" ? "create" : "invite",
      teamName: str("teamName"),
    });

    const session = await createUserSession(db, user.userId);
    await purgeExpiredSessions(db).catch(() => 0);
    await recordAudit(db, {
      actor: `${user.displayName}(${user.loginId})`,
      teamId: user.teamId,
      action: "user_signup",
      requestId: null,
      result: "ok",
      detail: `role=${user.role}`,
    });

    const response = NextResponse.json({
      ok: true,
      user: { loginId: user.loginId, displayName: user.displayName, teamId: user.teamId, role: user.role },
    });
    setSessionCookie(response, request, session.token, session.maxAgeSeconds);
    return response;
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

/** 화면이 "첫 사용자인가"(=초대 코드 입력칸을 숨길지)를 묻는다. */
export async function GET() {
  const db = await openDb();
  try {
    return NextResponse.json({ ok: true, first: (await countUsers(db)) === 0 });
  } catch {
    // DB 를 못 읽으면 코드를 요구하는 쪽으로 기운다(안전한 기본값).
    return NextResponse.json({ ok: true, first: false });
  } finally {
    await db.close();
  }
}
