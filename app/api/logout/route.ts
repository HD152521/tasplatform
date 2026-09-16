import { NextResponse } from "next/server";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_TEAM_ID, SESSION_FILE } from "../../../lib/config.ts";
import { clearTeamSessionInDb } from "../../../lib/sessionStore.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 저장된 세션을 지운다.
 *
 * 포털 쪽 세션을 끊는 것이 아니라 이 도구가 쓰던 세션 파일(과 DB 백업)을 없애는 것이다.
 * 지우고 나면 수집기는 session_expired 로 기록하고, /login 에서 다시 로그인해야 한다.
 */
export async function POST() {
  try {
    rmSync(resolve(SESSION_FILE), { force: true });
    // DB 백업도 지운다 — 안 그러면 다음 hydrate 가 지운 세션을 되살린다.
    await clearTeamSessionInDb(DEFAULT_TEAM_ID);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
