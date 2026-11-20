/**
 * 계정 잠금 방지 카운터.
 *
 * 수집기는 세션이 만료되면 15분마다 스스로 재로그인한다. 비밀번호가 바뀐 걸 모르면
 * 틀린 값을 한 시간에 네 번 IdP 로 보내고, 공용 계정이 잠긴다. 그래서 "두 번 틀리면
 * 멈추고, **사람이 손을 쓸 때까지 가만히 있는다**" 를 코드로 박았고, 여기서 잠근다.
 *
 * 가장 중요한 네 줄:
 *   - 두 번 실패하면 멈춘다.
 *   - **시간이 지나도 저절로 풀리지 않는다.** 저절로 다시 찔러 보면 IdP 의 실패
 *     카운터만 올라가고, 비밀번호는 시간이 지나도 고쳐지지 않는다.
 *   - OTP 는 실패가 아니다(비밀번호가 통과했다는 뜻). 이걸 실패로 세면 기기신뢰가
 *     만료된 날 멀쩡한 계정이 막힌다.
 *   - 비밀번호를 넣지 않은 실패는 세지 않는다. 망 장애가 계정 차단으로 번지면 안 된다.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 한도를 시험이 정하는 값으로 고정한다(모듈이 호출 때마다 읽는다).
process.env.SR_LOGIN_FAIL_LIMIT = "2";

import { openDb, type Db } from "../lib/db.ts";
import {
  LoginBlockedError,
  assertAutoLoginAllowed,
  clearLoginGuard,
  readLoginGuard,
  recordLoginAttempt,
} from "../lib/loginGuard.ts";
import type { AttemptFacts, LoginOutcome } from "../lib/loginOutcome.ts";

function freshDb(): Promise<Db> {
  return openDb(join(mkdtempSync(join(tmpdir(), "guard-")), "sr.db"));
}

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

/** 시도 한 번. 기본은 "비밀번호를 넣고 거절당했다". */
function facts(outcome: LoginOutcome, passwordSubmitted = true): AttemptFacts {
  return { outcome, reason: `${outcome} 테스트`, passwordSubmitted };
}

const reject = (): Promise<unknown> => recordLoginAttempt(db, facts("rejected"));

/* ------------------------------------------------------------------ *
 * 기본 상태
 * ------------------------------------------------------------------ */

test("처음에는 아무 기록도 멈춤도 없다", async () => {
  const state = await readLoginGuard(db);
  assert.equal(state.failCount, 0);
  assert.equal(state.blocked, false);
  assert.equal(state.blockedAt, "");
  assert.equal(state.lastAttemptAt, "");
  assert.equal(state.remaining, 2);
  await assertAutoLoginAllowed(db); // 던지지 않는다
});

/* ------------------------------------------------------------------ *
 * 두 번 실패 → 멈춘다. 그리고 **스스로 다시 시작하지 않는다.**
 * ------------------------------------------------------------------ */

test("한 번 실패는 아직 멈추지 않는다", async () => {
  await reject();
  const state = await readLoginGuard(db);
  assert.equal(state.failCount, 1);
  assert.equal(state.blocked, false);
  assert.equal(state.remaining, 1, "한 번 더 남았다고 알려야 한다");
  await assertAutoLoginAllowed(db);
});

test("두 번 실패하면 자동 시도를 멈춘다", async () => {
  await reject();
  assert.equal((await readLoginGuard(db)).blocked, false);

  await reject();
  const state = await readLoginGuard(db);
  assert.equal(state.blocked, true, "두 번이면 멈춰야 한다");
  assert.notEqual(state.blockedAt, "", "멈춘 시각을 남겨야 한다");
  assert.equal(state.remaining, 0);
});

test("멈춘 뒤에는 브라우저를 띄우기 전에 거절한다", async () => {
  await reject();
  await reject();
  await assert.rejects(
    () => assertAutoLoginAllowed(db),
    (error: unknown) => {
      assert.ok(error instanceof LoginBlockedError);
      assert.match(error.message, /멈췄습니다/);
      assert.match(error.message, /저절로 재시도하지 않습니다/, "저절로 안 푼다고 말해야 한다");
      assert.match(error.message, /settings\/account/, "복구 방법을 알려줘야 한다");
      return true;
    },
  );
});

test("멈춘 상태는 시간이 지나도 그대로다 — 쿨다운이 없다", async () => {
  await reject();
  await reject();

  // 상태를 다시 읽기만 해서는(=시간이 흘러도) 절대 풀리지 않는다. 풀 수 있는 것은
  // 사람의 동작(저장·로그인·버튼)뿐이다. 그 외에 blocked 를 0 으로 만드는 경로가
  // 생기면 이 시험이 깨진다.
  for (let i = 0; i < 3; i += 1) {
    const state = await readLoginGuard(db);
    assert.equal(state.blocked, true, `${i + 1}번째 조회에서 풀렸다`);
  }
  // 저장된 행에 "언제 다시 시도" 같은 값이 없어야 한다.
  const row = await db.get<Record<string, unknown>>(
    "SELECT * FROM portal_login_guard WHERE team_id = ?",
    ["default"],
  );
  assert.ok(row !== undefined);
  assert.ok(!("blocked_until" in row), "재시도 시각을 두면 저절로 풀리는 길이 생긴다");
});

test("멈춘 뒤의 추가 실패도 멈춤을 유지한다", async () => {
  await reject();
  await reject();
  const state = await recordLoginAttempt(db, facts("rejected"));
  assert.equal(state.blocked, true);
});

/* ------------------------------------------------------------------ *
 * 세지 말아야 하는 것들
 * ------------------------------------------------------------------ */

test("OTP 요구는 카운터를 되돌린다 — 비밀번호는 통과했다", async () => {
  await reject();
  const state = await recordLoginAttempt(db, facts("otp"));
  assert.equal(state.failCount, 0, "OTP 를 실패로 세면 멀쩡한 계정이 막힌다");
  assert.equal(state.blocked, false);
  assert.equal(state.lastResult, "otp");
});

test("비밀번호를 넣지 못한 실패는 세지 않는다", async () => {
  // 로그인 화면을 못 찾았거나 DNS 가 죽은 회차. IdP 의 실패 횟수와 무관하다.
  const once = await recordLoginAttempt(db, facts("failed", false));
  assert.equal(once.failCount, 0);
  const twice = await recordLoginAttempt(db, facts("failed", false));
  assert.equal(twice.failCount, 0);
  assert.equal(twice.blocked, false, "망 장애로 계정을 차단하면 안 된다");
  // 그래도 "무슨 일이 있었는지" 는 남는다.
  assert.equal(twice.lastResult, "failed");
  assert.notEqual(twice.lastAttemptAt, "");
});

test("비밀번호를 넣고 타임아웃난 실패는 센다", async () => {
  // 비번을 제출했으면 IdP 가 그걸 판정했을 수 있다. 안전한 쪽으로 센다.
  await recordLoginAttempt(db, facts("failed", true));
  const state = await recordLoginAttempt(db, facts("failed", true));
  assert.equal(state.blocked, true);
});

/* ------------------------------------------------------------------ *
 * 사람이 포털에서 손봐야 하는 것들 — 한 번에 멈춘다
 * ------------------------------------------------------------------ */

test("계정이 이미 잠겼으면 한 번에 멈춘다", async () => {
  const state = await recordLoginAttempt(db, facts("locked"));
  assert.equal(state.blocked, true, "더 찔러서 잠금을 늘리지 않는다");
  assert.equal(state.needsHuman, true);
});

test("비밀번호 만료도 한 번에 멈춘다", async () => {
  const state = await recordLoginAttempt(db, facts("expired"));
  assert.equal(state.blocked, true);
  assert.equal(state.needsHuman, true);
});

/* ------------------------------------------------------------------ *
 * 복구 — 전부 사람의 동작이다
 * ------------------------------------------------------------------ */

test("성공하면 전부 초기화된다", async () => {
  await reject();
  await reject();
  const state = await recordLoginAttempt(db, facts("ok"));
  assert.equal(state.blocked, false);
  assert.equal(state.failCount, 0);
  assert.equal(state.blockedAt, "");
  await assertAutoLoginAllowed(db);
});

test("새 자격을 저장하면 처음부터 다시 센다", async () => {
  await reject();
  await reject();
  await clearLoginGuard(db, undefined, "새 자격 저장", "full");

  const state = await readLoginGuard(db);
  assert.equal(state.blocked, false);
  assert.equal(state.failCount, 0);
  assert.equal(state.remaining, 2, "새 비밀번호면 한도를 모두 준다");
  assert.equal(state.lastResult, "rejected", "무엇 때문에 막혔었는지는 남아야 한다");
  assert.equal(state.lastReason, "새 자격 저장");
  await assertAutoLoginAllowed(db);
});

test("「한 번만 다시 시도」는 딱 한 번이다", async () => {
  await reject();
  await reject();
  await clearLoginGuard(db, undefined, "버튼", "one");

  const opened = await readLoginGuard(db);
  assert.equal(opened.blocked, false);
  assert.equal(opened.remaining, 1, "한 번만 남아야 한다");
  await assertAutoLoginAllowed(db);

  // 그 한 번이 실패하면 즉시 다시 멈춘다 — 버튼만 눌러서는 실패 횟수가 쌓이지 않는다.
  const after = await reject() as Awaited<ReturnType<typeof readLoginGuard>>;
  assert.equal(after.blocked, true);
});
