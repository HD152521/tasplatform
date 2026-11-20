import { NextResponse } from "next/server";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { actorOf, userFromRequestWith } from "../../../lib/appAuth.ts";
import { sessionFileForTeam } from "../../../lib/config.ts";
import { openDb, recordAudit } from "../../../lib/db.ts";
import { clearTeamSessionInDb } from "../../../lib/sessionStore.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * **그 팀의** 포털 세션을 지운다.
 *
 * ⚠ 앱 로그아웃(`/api/auth/signout`)과 다른 것이다. 이건 브로드컴 포털 세션을 끊어
 * **수집을 멈춘다**(다음 회차가 session_expired 로 기록되고, `/login` 에서 다시
 * 로그인해야 한다). 사이드바의 라벨을 「포털 세션 해제」로 둔 이유다.
 *
 * ## 전에는 남의 팀 세션을 지웠다
 *
 * 기본 팀을 박아 써서, 2번 팀 사람이 이 버튼을 누르면 **1번 팀의 수집이 멈췄다.**
 * 누른 사람은 자기 팀을 끊은 줄 알고, 1번 팀은 영문 모르고 수집이 멈춘다 — 조용히
 * 남의 것을 건드리는 종류의 사고다. 이제 세션에서 팀을 읽는다.
 *
 * 되돌릴 수 없는 동작이라 감사 로그에 남긴다.
 */
export async function POST(request: Request) {
  const db = await openDb();
  try {
    const me = await userFromRequestWith(db, request);
    if (me === null) {
      return NextResponse.json({ ok: false, message: "로그인이 필요합니다." }, { status: 401 });
    }
    if (me.teamId === "") {
      return NextResponse.json({ ok: false, message: "속한 팀이 없습니다." }, { status: 400 });
    }

    rmSync(resolve(sessionFileForTeam(me.teamId)), { force: true });
    // DB 백업도 지운다 — 안 그러면 다음 hydrate 가 지운 세션을 되살린다.
    await clearTeamSessionInDb(me.teamId);
    await recordAudit(db, {
      actor: actorOf(me), teamId: me.teamId, action: "portal_session_clear", requestId: null,
      result: "ok", detail: "",
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  } finally {
    await db.close();
  }
}
