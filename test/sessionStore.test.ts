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
