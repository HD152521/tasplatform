/**
 * 앱 로그인 세션.
 *
 * 가장 중요한 세 줄:
 *   - **쿠키에 담긴 평문 토큰이 DB 에 없다.** 해시만 들어간다(team_tokens 와 같은 방식).
 *   - 로그아웃은 **즉시** 듣는다 — 쿠키를 지우는 것만으로는 복사된 토큰이 계속 산다.
 *   - 만료된 세션은 통과하지 못한다. 수명을 못 읽는 세션도 통과하지 못한다
 *     ("읽을 수 없는 수명" 을 무제한으로 보면 그게 영구 토큰이 된다).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb, type Db } from "../lib/db.ts";
import {
  APP_SESSION_COOKIE,
  createUserSession,
  listUserSessions,
  purgeExpiredSessions,
  resolveUserSession,
  revokeAllUserSessions,
  revokeUserSession,
} from "../lib/appSession.ts";
import { signup } from "../lib/users.ts";

function freshDb(): Promise<Db> {
  return openDb(join(mkdtempSync(join(tmpdir(), "appsession-")), "sr.db"));
}

let db: Db;
let userId: number;

beforeEach(async () => {
  db = await freshDb();
  const user = await signup(db, {
    loginId: "yongsik",
    displayName: "안용식",
    password: "hunter2hunter2",
    inviteCode: "",
  });
  userId = user.userId;
});

test("쿠키 이름이 포털 쪽과 섞이지 않는다", () => {
  assert.equal(APP_SESSION_COOKIE, "sr_app_session");
});

test("만든 세션으로 사람을 찾을 수 있다", async () => {
  const session = await createUserSession(db, userId);
  const user = await resolveUserSession(db, session.token);
  assert.ok(user !== null);
  assert.equal(user.loginId, "yongsik");
  assert.equal(user.teamId, "default");
  assert.ok(session.maxAgeSeconds > 0);
});

test("평문 토큰은 DB 어디에도 없다", async () => {
  const session = await createUserSession(db, userId);
  const rows = await db.all<Record<string, unknown>>("SELECT * FROM user_sessions");
  assert.equal(rows.length, 1);
  assert.ok(
    !JSON.stringify(rows).includes(session.token),
    "DB 가 새어도 그 값으로 로그인할 수 없어야 한다",
  );
});

test("모르는 토큰·빈 값은 null 이다", async () => {
  assert.equal(await resolveUserSession(db, ""), null);
  assert.equal(await resolveUserSession(db, undefined), null);
  assert.equal(await resolveUserSession(db, null), null);
  assert.equal(await resolveUserSession(db, "made-up-token"), null);
});

test("로그아웃(해지)은 즉시 듣는다", async () => {
  const session = await createUserSession(db, userId);
  await revokeUserSession(db, session.token);
  assert.equal(await resolveUserSession(db, session.token), null);
});

test("비밀번호를 바꾸면 모든 기기의 세션이 끊긴다", async () => {
  const one = await createUserSession(db, userId);
  const two = await createUserSession(db, userId);
  await revokeAllUserSessions(db, userId);
  assert.equal(await resolveUserSession(db, one.token), null);
  assert.equal(await resolveUserSession(db, two.token), null);
});

test("만료된 세션은 통과하지 못한다", async () => {
  const session = await createUserSession(db, userId);
  await db.run("UPDATE user_sessions SET expires_at = ? WHERE user_id = ?", [
    new Date(Date.now() - 1000).toISOString(),
    userId,
  ]);
  assert.equal(await resolveUserSession(db, session.token), null);
});

test("수명을 읽을 수 없는 세션도 통과하지 못한다", async () => {
  // 깨진 값을 "무제한" 으로 보면 그게 영구 토큰이 된다.
  const session = await createUserSession(db, userId);
  await db.run("UPDATE user_sessions SET expires_at = ? WHERE user_id = ?", ["", userId]);
  assert.equal(await resolveUserSession(db, session.token), null);
});

test("정지된 계정의 세션은 살아 있어도 통과하지 못한다", async () => {
  const session = await createUserSession(db, userId);
  await db.run("UPDATE users SET disabled = 1 WHERE user_id = ?", [userId]);
  assert.equal(await resolveUserSession(db, session.token), null);
});

test("사용자 행이 사라지면 세션도 쓸모가 없다", async () => {
  const session = await createUserSession(db, userId);
  await db.run("DELETE FROM users WHERE user_id = ?", [userId]);
  assert.equal(await resolveUserSession(db, session.token), null);
});

test("만료 정리는 만료된 것만 지운다", async () => {
  const live = await createUserSession(db, userId);
  const dead = await createUserSession(db, userId);
  // 두 번째만 과거로 민다.
  const rows = await db.all<{ token_hash: string }>("SELECT token_hash FROM user_sessions");
  assert.equal(rows.length, 2);

  await db.run("UPDATE user_sessions SET expires_at = ? WHERE token_hash <> (SELECT token_hash FROM user_sessions ORDER BY created_at ASC LIMIT 1)", [
    new Date(Date.now() - 1000).toISOString(),
  ]);

  const removed = await purgeExpiredSessions(db);
  assert.equal(removed, 1);
  assert.ok((await resolveUserSession(db, live.token)) !== null, "살아 있는 세션은 남아야 한다");
  assert.equal(await resolveUserSession(db, dead.token), null);
});

test("세션 목록은 해시 앞부분만 보여 준다", async () => {
  const session = await createUserSession(db, userId);
  const list = await listUserSessions(db, userId);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.tokenHashPrefix.length, 12);
  assert.ok(
    !JSON.stringify(list).includes(session.token),
    "목록에도 평문이 실리면 안 된다",
  );
});
