/**
 * 세션/기기신뢰 상태의 DB 백업.
 *
 * session.json(Playwright storageState)·device.json(MFA 신뢰기기)은 파일이 정본이고,
 * Playwright/fetchClient 가 파일 경로로 읽고 쓴다. TAS 파일시스템은 ephemeral 이라
 * 재시작하면 이 파일들이 사라진다. 그래서 파일 로직은 그대로 두고, DB 를 durable
 * 백업으로 둔다:
 *   - persistTeamSessionToDb: 로컬 파일 → DB (로그인/쿠키 회전 후)
 *   - hydrateTeamSessionFromDb: DB → 로컬 파일 (컨테이너 시작·쓰기 전 복원)
 *
 * hydrate 는 로컬 파일이 없거나 **있어도 못 쓸 때**(SSO 세션 만료) DB 에서 복원한다.
 * 항상 덮어쓰면 방금 회전된 최신 파일을 오래된 DB 로 되돌릴 위험이 있으므로, 살아 있는
 * 파일은 건드리지 않고 DB 블롭도 살아 있을 때만 바꾼다.
 * server-only 를 붙이지 않는다. 수집기(Node)에서도 부른다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { assertValidTeamId, deviceFileForTeam, sessionFileForTeam } from "./config.ts";
import { getSessionStatus, sessionStatusFromJson } from "./sessionFile.ts";
import { openDb, type Db } from "./db.ts";
import { isoNow } from "./dates.ts";

function readIfExists(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

function writeEnsured(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

interface SessionRow {
  session_json: string;
  device_json: string;
}

/** 로컬 세션/기기 파일을 DB 로 밀어 넣는다(있는 것만; 빈 값은 기존을 지우지 않는다). */
export async function persistTeamSessionToDb(teamId: string, existing?: Db): Promise<void> {
  assertValidTeamId(teamId);
  const sessionJson = readIfExists(resolve(sessionFileForTeam(teamId)));
  const deviceJson = readIfExists(resolve(deviceFileForTeam(teamId)));
  if (sessionJson === "" && deviceJson === "") return; // 저장할 게 없으면 건드리지 않는다

  const db = existing ?? (await openDb());
  try {
    await db.run(
      `INSERT INTO team_session_state (team_id, session_json, device_json, updated_at)
       VALUES (?,?,?,?)
       ON CONFLICT(team_id) DO UPDATE SET
         session_json = CASE WHEN excluded.session_json = '' THEN team_session_state.session_json ELSE excluded.session_json END,
         device_json  = CASE WHEN excluded.device_json  = '' THEN team_session_state.device_json  ELSE excluded.device_json END,
         updated_at   = excluded.updated_at`,
      [teamId, sessionJson, deviceJson, isoNow()],
    );
  } finally {
    if (!existing) await db.close();
  }
}

/**
 * DB 블롭으로 세션 파일을 덮어쓸 만한가.
 *
 * 파일이 아예 없으면 무엇이든 없는 것보다 낫다. 파일이 있는데 만료된 경우에는 **DB 블롭이
 * 살아 있을 때만** 바꾼다 — 만료된 것을 만료된 것으로 바꾸면 얻는 건 없고, 그 파일에
 * 남은 기기 신뢰 표식(1년짜리 _iat1 등)까지 잃어 다음 재로그인에서 OTP 를 다시 묻는다.
 */
function isWorthRestoring(sessionJson: string, sessionPath: string): boolean {
  if (!existsSync(sessionPath)) return true;
  return !sessionStatusFromJson(sessionJson).expired;
}

/**
 * DB 의 세션/기기 블롭을 로컬 파일로 복원한다.
 *
 * 예전 규칙은 "파일이 있으면 그대로 둔다" 였다. 파일과 DB 를 **늘 함께 갱신하는 한 대**
 * 에서만 맞는 규칙이다. 실제 배치는 두 대다 — 수집기 VM 과 웹은 파일시스템이 다르다.
 * 그래서 VM 이 재로그인해 DB 를 갱신해도 웹의 낡은 파일이 그대로 남아, 수집은 계속
 * 성공하는데 SR 등록만 "세션이 만료되었습니다" 로 막혔다. 만료된 파일은 붙잡아 둘
 * 이유가 없으므로 DB 쪽이 살아 있으면 가져온다.
 */
export async function hydrateTeamSessionFromDb(teamId: string, existing?: Db): Promise<void> {
  assertValidTeamId(teamId);
  const sessionPath = resolve(sessionFileForTeam(teamId));
  const devicePath = resolve(deviceFileForTeam(teamId));

  // 파일이 없으면 getSessionStatus 가 expired:true 를 준다 — 두 경우를 함께 다룬다.
  const needSession = getSessionStatus(teamId).expired;
  const needDevice = !existsSync(devicePath);
  // 세션이 멀쩡하고 기기 파일도 있으면 DB 를 열 필요조차 없다(워밍된 컨테이너의 흔한 경로).
  if (!needSession && !needDevice) return;

  const db = existing ?? (await openDb());
  try {
    const row = await db.get<SessionRow>(
      "SELECT session_json, device_json FROM team_session_state WHERE team_id = ?",
      [teamId],
    );
    if (!row) return;
    if (row.session_json && needSession && isWorthRestoring(row.session_json, sessionPath)) {
      writeEnsured(sessionPath, row.session_json);
    }
    if (row.device_json && needDevice) writeEnsured(devicePath, row.device_json);
  } finally {
    if (!existing) await db.close();
  }
}

/** 로그아웃 등에서 DB 백업도 지운다. */
export async function clearTeamSessionInDb(teamId: string, existing?: Db): Promise<void> {
  assertValidTeamId(teamId);
  const db = existing ?? (await openDb());
  try {
    await db.run("DELETE FROM team_session_state WHERE team_id = ?", [teamId]);
  } finally {
    if (!existing) await db.close();
  }
}
