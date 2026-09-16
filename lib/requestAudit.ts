/**
 * 쓰기 경로(답변/작성)의 actor/team 처리 + 감사 로그 연결.
 *
 * server-only 를 붙이지 않는다 — node:test 로 직접 단위테스트하기 위해서다.
 * 라우트가 실제로 브로드컴에 쓰는 lib/reply.ts·lib/createCase.ts 는 server-only 라
 * node --test 에서 못 불러온다(실측 확인). 그래서 그 두 라우트가 공통으로 쓰는
 * "actor/team 뽑기"와 "감사 로그 남기기"만 이 파일로 분리해 여기서 테스트한다.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_TEAM_ID, assertValidTeamId, sessionFileForTeam } from "./config.ts";
import { openDb, recordAudit } from "./db.ts";
import type { AuditEntry } from "./db.ts";

export type ActorTeamResult =
  | { ok: true; actor: string; teamId: string }
  | { ok: false; message: string };

/**
 * 요청 바디에서 actor(요청 사용자 식별자)와 team(대상 팀)을 뽑는다.
 *
 * 하위호환 필수: 지금 SR 뷰어 화면은 이 필드 없이 호출한다.
 * team 이 없거나 빈 문자열이면 기본 팀(DEFAULT_TEAM_ID), actor 가 없으면 빈 문자열로
 * 처리해서 기존 화면 호출이 그대로 동작해야 한다.
 *
 * team 형식이 잘못되면(assertValidTeamId 실패) ok:false 로 이유를 돌려준다.
 * 호출부(라우트)가 이를 400 응답으로 옮긴다.
 */
export function resolveActorTeam(body: { actor?: unknown; team?: unknown }): ActorTeamResult {
  const actor = typeof body.actor === "string" ? body.actor.trim() : "";
  const teamRaw = typeof body.team === "string" ? body.team.trim() : "";
  const teamId = teamRaw === "" ? DEFAULT_TEAM_ID : teamRaw;

  try {
    assertValidTeamId(teamId);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, actor, teamId };
}

/**
 * 쓰기 실행(성공/실패) 뒤 감사 로그 한 줄을 남긴다.
 *
 * DB open/close 를 감싼다. recordAudit 자체가 내부에서 예외를 삼키지만,
 * openDb 가 실패하는 극단적인 경우까지 방어해서 감사 로그 실패가 본 응답을
 * 막지 않게 한다(요구사항: 로그 실패가 본 작업을 막지 않을 것).
 *
 * dbFile 은 테스트에서 임시 DB 를 쓰기 위한 것이다. 실제 라우트는 생략해서
 * 기본 DB(DB_FILE)를 쓴다.
 */
export async function recordWriteAudit(entry: AuditEntry, dbFile?: string): Promise<void> {
  let db;
  try {
    db = await openDb(dbFile);
  } catch (error) {
    console.error("[audit] DB 를 열지 못해 감사 로그를 남기지 못했습니다", error);
    return;
  }
  try {
    await recordAudit(db, entry);
  } finally {
    await db.close();
  }
}

/**
 * 그 팀의 세션 파일이 있는지 확인한다.
 *
 * 쓰기(답변/작성) 시도 **전에** 불러서, 세션이 없으면 브로드컴에 요청조차 보내지
 * 않고 바로 401 을 돌려주기 위한 것이다. reply·create 두 라우트가 대칭으로
 * 이 함수를 쓴다. (덤으로 Step 4 MCP 의 "세션 없으면 로그인 유도" 요구도
 * 여기서 같이 충족된다.)
 */
export function hasTeamSession(teamId: string): boolean {
  return existsSync(resolve(sessionFileForTeam(teamId)));
}

/**
 * 쓰기 자체가 이미 성공한 "뒤"의 부수효과(세션 쿠키 저장·목록/스레드 새로고침)를
 * 실행한다. 실패해도 예외를 삼켜 이미 확정된 성공 응답·감사 로그를 흔들지 않는다
 * — persist 는 쿠키 저장일 뿐이고, refresh 는 다음 정기 수집이 어차피 채운다.
 * console.error 로만 남긴다.
 *
 * reply·create 라우트가 postReply/createCase 가 ok:true 를 반환한 뒤에만 부른다.
 */
export async function runSideEffect(label: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.error(`[audit] 부수효과 실패 (쓰기 자체는 이미 성공): ${label}`, error);
  }
}
