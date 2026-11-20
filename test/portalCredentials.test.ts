/**
 * 포털 공용 계정 자격 저장·조회.
 *
 * 여기가 틀리면 비밀번호가 새거나(평문 노출), 바꾼 값이 반영되지 않아 옛 비밀번호로
 * 로그인을 시도한다(계정 잠김). 그 둘을 각각 잠근다.
 *
 * ⚠ 환경변수를 **import 보다 먼저** 세팅한다 — lib/config.ts 의 CREDENTIALS 는 모듈을
 *   읽는 순간 한 번 계산되는 상수다(.env 폴백 경로).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SR_SECRET_KEY = Buffer.alloc(32, 11).toString("base64");
process.env.SR_USERNAME = "env-user@example.com";
process.env.SR_PASSWORD = "env-password";

const { openDb } = await import("../lib/db.ts");
type Db = Awaited<ReturnType<typeof openDb>>;
const {
  deletePortalCredentials,
  getPortalCredentials,
  getPortalCredentialsMeta,
  savePortalCredentials,
  savePortalCredentialsEncrypted,
} = await import("../lib/portalCredentials.ts");
const { readLoginGuard, recordLoginAttempt } = await import("../lib/loginGuard.ts");
const { encryptSecret } = await import("../lib/secretBox.ts");

let db: Db;
beforeEach(async () => {
  db = await openDb(join(mkdtempSync(join(tmpdir(), "portalcred-")), "sr.db"));
});

/* ------------------------------------------------------------------ *
 * 폴백 — 기존 설치가 그대로 돌아야 한다
 * ------------------------------------------------------------------ */

test("저장된 값이 없으면 .env 를 쓴다", async () => {
  const creds = await getPortalCredentials(db);
  assert.equal(creds?.username, "env-user@example.com");
  assert.equal(creds?.password, "env-password");
  assert.equal(creds?.source, "env", "어디서 왔는지 말해야 한다");
});

test("저장하면 .env 를 이긴다", async () => {
  await savePortalCredentials(db, { username: "db-user@example.com", password: "db-password" });
  const creds = await getPortalCredentials(db);
  assert.equal(creds?.username, "db-user@example.com");
  assert.equal(creds?.password, "db-password");
  assert.equal(creds?.source, "db");
});

test("아이디만 있고 비밀번호가 없는 행은 쓰지 않는다", async () => {
  // 어중간한 행으로 로그인을 시도하면 반드시 실패하고, 그 실패가 카운터를 올린다.
  await db.run(
    "INSERT INTO portal_credentials (team_id, username, password_enc, updated_at) VALUES (?,?,?,?)",
    ["default", "half@example.com", "", new Date().toISOString()],
  );
  const creds = await getPortalCredentials(db);
  assert.equal(creds?.source, "env", "불완전한 행은 건너뛰고 폴백해야 한다");
});

/* ------------------------------------------------------------------ *
 * 비밀번호가 새지 않는다
 * ------------------------------------------------------------------ */

test("DB 에는 평문이 들어가지 않는다", async () => {
  await savePortalCredentials(db, { username: "u@example.com", password: "sup3r-secret" });
  const row = await db.get<{ password_enc: string }>(
    "SELECT password_enc FROM portal_credentials WHERE team_id = ?",
    ["default"],
  );
  assert.ok(row !== undefined);
  assert.doesNotMatch(row.password_enc, /sup3r-secret/, "평문이 보이면 안 된다");
  assert.match(row.password_enc, /^v1:/, "secretBox 형식이어야 한다");
});

test("화면용 조회는 비밀번호를 담지 않는다", async () => {
  await savePortalCredentials(db, {
    username: "u@example.com",
    password: "sup3r-secret",
    actor: "someone",
  });
  const meta = await getPortalCredentialsMeta(db);
  assert.equal(meta.username, "u@example.com");
  assert.equal(meta.hasPassword, true);
  assert.equal(meta.source, "db");
  assert.equal(meta.updatedBy, "someone");
  assert.doesNotMatch(JSON.stringify(meta), /sup3r-secret/, "평문도 암호문도 나가면 안 된다");
  assert.doesNotMatch(JSON.stringify(meta), /^.*v1:/);
});

/* ------------------------------------------------------------------ *
 * 저장 규칙
 * ------------------------------------------------------------------ */

test("비밀번호를 비워 보내면 기존 값을 유지한다", async () => {
  await savePortalCredentials(db, { username: "u@example.com", password: "keep-me" });
  await savePortalCredentials(db, { username: "new@example.com", password: "" });

  const creds = await getPortalCredentials(db);
  assert.equal(creds?.username, "new@example.com", "아이디만 바뀐다");
  assert.equal(creds?.password, "keep-me", "비밀번호는 그대로");
});

test("처음 저장에 비밀번호가 비면 거부한다", async () => {
  await assert.rejects(
    () => savePortalCredentials(db, { username: "u@example.com", password: "" }),
    /비밀번호를 입력하세요/,
  );
});

test("아이디가 비면 거부한다", async () => {
  await assert.rejects(
    () => savePortalCredentials(db, { username: "   ", password: "x" }),
    /아이디를 입력하세요/,
  );
});

test("팀 라벨(broadcom_username)도 같이 맞춘다", async () => {
  await savePortalCredentials(db, { username: "label@example.com", password: "x" });
  const row = await db.get<{ broadcom_username: string }>(
    "SELECT broadcom_username FROM teams WHERE team_id = ?",
    ["default"],
  );
  assert.equal(row?.broadcom_username, "label@example.com");
});

test("암호문을 그대로 받는 경로도 같은 값을 돌려준다", async () => {
  // 로그인 화면의 「자동 로그인에 쓰기」 경로. 평문을 들고 있지 않기 위해 쓴다.
  await savePortalCredentialsEncrypted(db, {
    username: "flow@example.com",
    passwordEnc: encryptSecret("from-login-screen"),
  });
  const creds = await getPortalCredentials(db);
  assert.equal(creds?.username, "flow@example.com");
  assert.equal(creds?.password, "from-login-screen");
});

/* ------------------------------------------------------------------ *
 * 잠금 방지와의 연결 — 저장이 복구 경로다
 * ------------------------------------------------------------------ */

test("새 자격을 저장하면 차단이 풀린다", async () => {
  await recordLoginAttempt(db, { outcome: "rejected", reason: "틀림", passwordSubmitted: true });
  await recordLoginAttempt(db, { outcome: "rejected", reason: "틀림", passwordSubmitted: true });
  assert.equal((await readLoginGuard(db)).blocked, true);

  await savePortalCredentials(db, { username: "u@example.com", password: "new-password" });

  const state = await readLoginGuard(db);
  assert.equal(state.blocked, false, "사람이 새 값을 넣었으면 즉시 다시 시도해야 한다");
  assert.equal(state.failCount, 0);
});

test("삭제하면 .env 로 돌아가고 차단도 풀린다", async () => {
  await savePortalCredentials(db, { username: "u@example.com", password: "x" });
  await recordLoginAttempt(db, { outcome: "rejected", reason: "틀림", passwordSubmitted: true });
  await recordLoginAttempt(db, { outcome: "rejected", reason: "틀림", passwordSubmitted: true });

  await deletePortalCredentials(db);

  const creds = await getPortalCredentials(db);
  assert.equal(creds?.source, "env");
  assert.equal((await readLoginGuard(db)).blocked, false);
});

/* ------------------------------------------------------------------ *
 * 키가 어긋났을 때 — 조용히 옛 값으로 내려가지 않는다
 * ------------------------------------------------------------------ */

test("복호화가 안 되면 터뜨린다 (.env 로 몰래 내려가지 않는다)", async () => {
  // 내려가면 옛 비밀번호로 로그인을 시도하고, 그게 계정 잠김으로 간다.
  await db.run(
    "INSERT INTO portal_credentials (team_id, username, password_enc, updated_at) VALUES (?,?,?,?)",
    ["default", "u@example.com", "v1:bad:bad:bad", new Date().toISOString()],
  );
  await assert.rejects(() => getPortalCredentials(db), /복호화할 수 없습니다/);
});
