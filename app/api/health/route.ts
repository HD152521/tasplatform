import { NextResponse } from "next/server";
import { listTeams, openDb, type Db } from "../../../lib/db.ts";
import { isoNow } from "../../../lib/dates.ts";
import { healthError, healthOk } from "../../../lib/health.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 배포 검증용 헬스체크. DB 를 열어 아주 가벼운 조회(팀 목록)를 한 번 하고 상태를 JSON 으로 준다.
 *
 * 성공: { ok: true, dialect, teams, at } — 방언과 팀 수만 노출한다(접속정보·계정·스키마 비노출).
 * 실패: { ok: false, error } + 500 — error 는 lib/health 의 고정 요약 코드뿐이라 자격/호스트가
 *       새지 않는다. 디버깅용 원문은 서버 로그(console.error)에만 남긴다.
 */
export async function GET() {
  let db: Db | undefined;
  try {
    db = await openDb();
    const teams = await listTeams(db);
    return NextResponse.json(healthOk(db.dialect, teams.length, isoNow()));
  } catch (error) {
    // 원문은 서버 로그에만(응답엔 요약 코드만). 배포 컨테이너 로그로 원인 추적이 가능하게 남긴다.
    console.error("[api/health] DB 확인 실패", error);
    return NextResponse.json(healthError(error), { status: 500 });
  } finally {
    if (db) await db.close();
  }
}
