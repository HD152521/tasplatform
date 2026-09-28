/**
 * 세션/기기 상태 DB 백업.
 *
 * 재시작으로 파일이 사라져도 DB 에서 복원되는지, 그리고 파일이 이미 있으면(워밍된 컨테이너)
 * 오래된 DB 로 덮어써 세션을 만료시키지 않는지 — 여기가 틀리면 재로그인이 잦아지거나
 * 방금 회전된 세션이 되돌려진다.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { deviceFileForTeam, sessionFileForTeam } from "../lib/config.ts";
import { openDb } from "../lib/db.ts";
import {
  clearTeamSessionInDb,
  hydrateTeamSessionFromDb,
  persistTeamSessionToDb,
} from "../lib/sessionStore.ts";

const TEAM = `sesstest-${Date.now()}`;
const sessionPath = resolve(sessionFileForTeam(TEAM));
const devicePath = resolve(deviceFileForTeam(TEAM));

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}
function rmFiles(): void {
  rmSync(sessionPath, { force: true });
  rmSync(devicePath, { force: true });
}

after(() => {
  // 테스트가 만든 data/teams/<team> 디렉터리를 정리한다.
  try { rmSync(resolve(`data/teams/${TEAM}`), { recursive: true, force: true }); } catch { /* noop */ }
});

test("persist → 파일 삭제(재시작) → hydrate 로 복원된다", async () => {
  const db = await openDb(join(mkdtempSync(join(tmpdir(), "sess-")), "sr.db"));
  writeFile(sessionPath, '{"cookies":["sid=abc"]}');
  writeFile(devicePath, '{"cookies":["_iat1=trust"]}');

  await persistTeamSessionToDb(TEAM, db);

  rmFiles();
  assert.equal(existsSync(sessionPath), false);
  assert.equal(existsSync(devicePath), false);

  await hydrateTeamSessionFromDb(TEAM, db);
  assert.equal(existsSync(sessionPath), true, "세션 파일이 복원돼야");
  assert.equal(existsSync(devicePath), true, "기기 파일이 복원돼야");
  assert.equal(readFileSync(sessionPath, "utf8"), '{"cookies":["sid=abc"]}');
  assert.equal(readFileSync(devicePath, "utf8"), '{"cookies":["_iat1=trust"]}');

  rmFiles();
  await db.close();
});

test("파일이 이미 있으면(워밍) 오래된 DB 로 덮어쓰지 않는다", async () => {
  const db = await openDb(join(mkdtempSync(join(tmpdir(), "sess-")), "sr.db"));
  writeFile(sessionPath, '{"cookies":["old"]}');
  writeFile(devicePath, '{"cookies":["_iat1=trust"]}');
  await persistTeamSessionToDb(TEAM, db);

  // 파일이 최신으로 회전됨 (DB 는 아직 old)
  writeFile(sessionPath, '{"cookies":["ROTATED-NEW"]}');
  await hydrateTeamSessionFromDb(TEAM, db);

  assert.equal(
    readFileSync(sessionPath, "utf8"), '{"cookies":["ROTATED-NEW"]}',
    "존재하는 파일은 DB 로 덮이지 않아야(세션 만료 방지)",
  );

  rmFiles();
  await db.close();
});

test("저장할 게 없으면(파일 둘 다 없음) DB 를 건드리지 않는다", async () => {
  const db = await openDb(join(mkdtempSync(join(tmpdir(), "sess-")), "sr.db"));
  rmFiles();
  await persistTeamSessionToDb(TEAM, db); // 파일 없음 → no-op
  const row = await db.get("SELECT team_id FROM team_session_state WHERE team_id = ?", [TEAM]);
  assert.equal(row, undefined, "빈 상태를 저장하지 않아야");
  await db.close();
});

test("clear 후에는 hydrate 로 복원되지 않는다", async () => {
  const db = await openDb(join(mkdtempSync(join(tmpdir(), "sess-")), "sr.db"));
  writeFile(sessionPath, '{"cookies":["sid=abc"]}');
  await persistTeamSessionToDb(TEAM, db);
  await clearTeamSessionInDb(TEAM, db);

  rmFiles();
  await hydrateTeamSessionFromDb(TEAM, db);
  assert.equal(existsSync(sessionPath), false, "clear 후엔 복원되지 않아야");
  await db.close();
});

/* ------------------------------------------------------------------ *
 * 두 대(수집기 VM · 웹)에서 세션이 갈리는 문제
 *
 * 예전 규칙은 "파일이 있으면 그대로 둔다" 였다. 파일과 DB 를 늘 함께 갱신하는 한 대에서만
 * 맞는 규칙이라, 수집기가 재로그인해 DB 를 갱신해도 웹의 낡은 파일이 남아 SR 등록만
 * "세션이 만료되었습니다" 로 막혔다. 만료된 파일은 붙잡지 않는다.
 * ------------------------------------------------------------------ */

const HOUR_MS = 3_600_000;
/** 실제 쿠키 값은 쓰지 않는다 — 판정에 쓰이는 것은 이름과 만료뿐이다. */
function sessionJson(hoursFromNow: number): string {
  return JSON.stringify({
    cookies: [
      { name: "sspsession", domain: ".access.broadcom.com", expires: (Date.now() + hoursFromNow * HOUR_MS) / 1000 },
    ],
  });
}

test("만료된 파일은 살아 있는 DB 세션으로 바뀐다", async () => {
  const db = await openDb(join(mkdtempSync(join(tmpdir(), "sess-")), "sr.db"));
  // 수집기가 방금 로그인해 DB 에 살아 있는 세션을 올려 둔 상태를 만든다.
  const live = sessionJson(6);
  writeFile(sessionPath, live);
  writeFile(devicePath, '{"cookies":["_iat1=trust"]}');
  await persistTeamSessionToDb(TEAM, db);

  // 웹 쪽 파일은 나흘 전 것으로 멈춰 있다.
  writeFile(sessionPath, sessionJson(-96));

  await hydrateTeamSessionFromDb(TEAM, db);
  assert.equal(
    readFileSync(sessionPath, "utf8"), live,
    "만료된 파일을 붙잡고 있으면 SR 등록이 계속 막힌다",
  );

  rmFiles();
  await db.close();
});

test("만료된 파일을 만료된 DB 세션으로 바꾸지는 않는다", async () => {
  const db = await openDb(join(mkdtempSync(join(tmpdir(), "sess-")), "sr.db"));
  writeFile(sessionPath, sessionJson(-200)); // DB 에 들어갈 쪽이 더 낡았다
  await persistTeamSessionToDb(TEAM, db);

  const mine = sessionJson(-1); // 내 파일도 만료지만 그나마 최근
  writeFile(sessionPath, mine);

  await hydrateTeamSessionFromDb(TEAM, db);
  assert.equal(
    readFileSync(sessionPath, "utf8"), mine,
    "둘 다 만료면 바꿔 얻는 것이 없다 — 파일에 남은 기기 신뢰 표식만 잃는다",
  );

  rmFiles();
  await db.close();
});

test("살아 있는 파일은 DB 를 보지도 않고 그대로 둔다", async () => {
  const db = await openDb(join(mkdtempSync(join(tmpdir(), "sess-")), "sr.db"));
  writeFile(sessionPath, sessionJson(-96)); // DB 쪽은 만료본
  writeFile(devicePath, '{"cookies":["_iat1=trust"]}');
  await persistTeamSessionToDb(TEAM, db);

  const fresh = sessionJson(12); // 방금 회전된 최신 파일
  writeFile(sessionPath, fresh);

  await hydrateTeamSessionFromDb(TEAM, db);
  assert.equal(
    readFileSync(sessionPath, "utf8"), fresh,
    "최신 파일을 오래된 DB 로 되돌리면 세션이 만료된다",
  );

  rmFiles();
  await db.close();
});

test("세션이 멀쩡해도 기기 파일이 없으면 그것만 복원한다", async () => {
  const db = await openDb(join(mkdtempSync(join(tmpdir(), "sess-")), "sr.db"));
  const fresh = sessionJson(12);
  writeFile(sessionPath, fresh);
  writeFile(devicePath, '{"cookies":["_iat1=trust"]}');
  await persistTeamSessionToDb(TEAM, db);

  rmSync(devicePath, { force: true });
  await hydrateTeamSessionFromDb(TEAM, db);

  assert.equal(existsSync(devicePath), true, "기기 파일은 복원돼야(OTP 재입력 방지)");
  assert.equal(readFileSync(sessionPath, "utf8"), fresh, "세션 파일은 건드리지 않아야");

  rmFiles();
  await db.close();
});
