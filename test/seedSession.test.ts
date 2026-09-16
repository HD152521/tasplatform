/**
 * 세션 시딩 CLI 의 순수 로직(seedSession) 테스트.
 *
 * 밀폐(hermetic): 임시 SQLite db 를 주입하고, 임시 팀 id 로 로컬 세션 파일을 만든 뒤
 * team_session_state 에 들어가는지 확인한다. 실제 DB/네트워크에 붙지 않는다.
 * (scripts/seed-session.ts 는 진입점 가드가 있어 import 만으로 main 이 돌지 않는다.)
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { deviceFileForTeam, sessionFileForTeam } from "../lib/config.ts";
import { openDb, type Db } from "../lib/db.ts";
import { seedSession } from "../scripts/seed-session.ts";

// 로그로 새면 안 되는 민감값(테스트 감시용 마커).
const SECRET_SESSION = '{"cookies":["sid=SUPERSECRET-abc123"]}';
const SECRET_DEVICE = '{"cookies":["_iat1=TRUST-TOKEN-xyz"]}';

const TEAM = `seedtest-${Date.now()}`;
const sessionPath = resolve(sessionFileForTeam(TEAM));
const devicePath = resolve(deviceFileForTeam(TEAM));

function writeLocal(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}
function rmFiles(): void {
  rmSync(sessionPath, { force: true });
  rmSync(devicePath, { force: true });
}
function tempDb(): Promise<Db> {
  return openDb(join(mkdtempSync(join(tmpdir(), "seed-")), "sr.db"));
}

after(() => {
  try {
    rmSync(resolve(`data/teams/${TEAM}`), { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

test("로컬 파일이 있으면 team_session_state 에 저장된다", async () => {
  const db = await tempDb();
  writeLocal(sessionPath, SECRET_SESSION);
  writeLocal(devicePath, SECRET_DEVICE);

  const result = await seedSession(TEAM, db);
  assert.equal(result.uploaded, true, "업로드했다고 보고해야");
  assert.equal(result.dialect, "sqlite", "임시 db 는 sqlite");

  const row = await db.get<{ session_json: string; device_json: string }>(
    "SELECT session_json, device_json FROM team_session_state WHERE team_id = ?",
    [TEAM],
  );
  assert.ok(row, "행이 저장돼야");
  assert.equal(row.session_json, SECRET_SESSION);
  assert.equal(row.device_json, SECRET_DEVICE);

  rmFiles();
  await db.close();
});

test("로컬 파일이 없으면 no-op(uploaded=false) 이고 DB 를 건드리지 않는다", async () => {
  const db = await tempDb();
  rmFiles();

  const result = await seedSession(TEAM, db);
  assert.equal(result.uploaded, false, "심을 게 없으면 업로드하지 않아야");

  const row = await db.get(
    "SELECT team_id FROM team_session_state WHERE team_id = ?",
    [TEAM],
  );
  assert.equal(row, undefined, "빈 상태를 저장하지 않아야");
  await db.close();
});

test("반환값·로그로 민감값(쿠키/기기토큰)이 새지 않는다", async () => {
  const db = await tempDb();
  writeLocal(sessionPath, SECRET_SESSION);
  writeLocal(devicePath, SECRET_DEVICE);

  const captured: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]): void => {
    captured.push(args.map((a) => String(a)).join(" "));
  };
  console.error = (...args: unknown[]): void => {
    captured.push(args.map((a) => String(a)).join(" "));
  };

  let result: Awaited<ReturnType<typeof seedSession>>;
  try {
    result = await seedSession(TEAM, db);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }

  const haystack = `${JSON.stringify(result)}\n${captured.join("\n")}`;
  assert.equal(haystack.includes("SUPERSECRET"), false, "세션 쿠키가 새면 안 된다");
  assert.equal(haystack.includes("TRUST-TOKEN"), false, "기기 신뢰 토큰이 새면 안 된다");
  // 반환값은 메타만 담는다.
  assert.deepEqual(Object.keys(result).sort(), ["dialect", "uploaded"]);

  rmFiles();
  await db.close();
});
