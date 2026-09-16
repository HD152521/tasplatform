import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthRateLimiter } from "../mcp/rateLimit.ts";

test("실패가 없으면 차단되지 않는다", () => {
  const limiter = new AuthRateLimiter();
  assert.equal(limiter.isBlocked("1.2.3.4"), false);
});

test("상한 미만의 실패는 차단하지 않는다", () => {
  const limiter = new AuthRateLimiter({ maxFailures: 5, windowMs: 60_000, blockMs: 60_000 });
  const now = 1_000_000;
  for (let i = 0; i < 4; i += 1) limiter.recordFailure("1.2.3.4", now);
  assert.equal(limiter.isBlocked("1.2.3.4", now), false);
});

test("상한에 도달하면 차단한다", () => {
  const limiter = new AuthRateLimiter({ maxFailures: 5, windowMs: 60_000, blockMs: 60_000 });
  const now = 1_000_000;
  for (let i = 0; i < 5; i += 1) limiter.recordFailure("1.2.3.4", now);
  assert.equal(limiter.isBlocked("1.2.3.4", now), true);
});

test("차단 시간이 지나면 다시 허용한다", () => {
  const limiter = new AuthRateLimiter({ maxFailures: 3, windowMs: 60_000, blockMs: 10_000 });
  const now = 1_000_000;
  for (let i = 0; i < 3; i += 1) limiter.recordFailure("1.2.3.4", now);
  assert.equal(limiter.isBlocked("1.2.3.4", now), true);
  assert.equal(limiter.isBlocked("1.2.3.4", now + 10_001), false);
});

test("성공 기록은 실패 이력을 지운다", () => {
  const limiter = new AuthRateLimiter({ maxFailures: 3, windowMs: 60_000, blockMs: 10_000 });
  const now = 1_000_000;
  limiter.recordFailure("1.2.3.4", now);
  limiter.recordFailure("1.2.3.4", now);
  limiter.recordSuccess("1.2.3.4");
  limiter.recordFailure("1.2.3.4", now);
  assert.equal(limiter.isBlocked("1.2.3.4", now), false);
});

test("창(window) 시간이 지나면 실패 카운트가 초기화된다", () => {
  const limiter = new AuthRateLimiter({ maxFailures: 3, windowMs: 5_000, blockMs: 10_000 });
  const now = 1_000_000;
  limiter.recordFailure("1.2.3.4", now);
  limiter.recordFailure("1.2.3.4", now + 1_000);
  // 창을 넘겨서 실패 — 카운트가 1로 리셋돼야 한다
  limiter.recordFailure("1.2.3.4", now + 10_000);
  limiter.recordFailure("1.2.3.4", now + 10_100);
  assert.equal(limiter.isBlocked("1.2.3.4", now + 10_200), false);
});

test("서로 다른 출처는 독립적으로 추적한다", () => {
  const limiter = new AuthRateLimiter({ maxFailures: 2, windowMs: 60_000, blockMs: 10_000 });
  const now = 1_000_000;
  limiter.recordFailure("1.2.3.4", now);
  limiter.recordFailure("1.2.3.4", now);
  assert.equal(limiter.isBlocked("1.2.3.4", now), true);
  assert.equal(limiter.isBlocked("5.6.7.8", now), false);
});

// ── Fix A: Map 무한 증가 방지 ──────────────────────────────────────

test("서로 다른 출처 다수가 실패해도 시간이 지나 창이 만료되면 sweep 으로 크기가 준다", () => {
  const limiter = new AuthRateLimiter({
    maxFailures: 5, windowMs: 1_000, blockMs: 1_000, sweepIntervalMs: 1_000, maxEntries: 100_000,
  });
  const now = 1_000_000;

  // 서로 다른 출처 500개가 각각 한 번씩 실패한다 (차단까지는 안 간다).
  for (let i = 0; i < 500; i += 1) limiter.recordFailure(`ip-${i}`, now);
  assert.equal(limiter.size, 500);

  // 창(1s)도 지나고 sweep 주기(1s)도 지난 시점에 새 출처 하나가 실패한다.
  // 이 호출이 sweep 을 트리거해서 만료된 500개를 지워야 한다.
  const later = now + 5_000;
  limiter.recordFailure("new-ip", later);

  // 새로 기록한 것 하나만 남고 나머지는 청소됐어야 한다.
  assert.equal(limiter.size, 1);
});

test("isBlocked 호출만으로도 sweep 주기가 지나면 청소된다", () => {
  const limiter = new AuthRateLimiter({
    maxFailures: 5, windowMs: 1_000, blockMs: 1_000, sweepIntervalMs: 1_000, maxEntries: 100_000,
  });
  const now = 1_000_000;
  for (let i = 0; i < 200; i += 1) limiter.recordFailure(`ip-${i}`, now);
  assert.equal(limiter.size, 200);

  const later = now + 5_000;
  limiter.isBlocked("ip-0", later);
  assert.equal(limiter.size, 0);
});

test("아직 차단 중인 엔트리는 sweep 이 지나도 지우지 않는다", () => {
  const limiter = new AuthRateLimiter({
    maxFailures: 2, windowMs: 1_000, blockMs: 100_000, sweepIntervalMs: 1_000, maxEntries: 100_000,
  });
  const now = 1_000_000;
  // 같은 창 안에서 두 번 실패해 차단시킨다 (maxFailures=2).
  limiter.recordFailure("blocked-ip", now);
  limiter.recordFailure("blocked-ip", now);
  assert.equal(limiter.isBlocked("blocked-ip", now), true);

  // 창(windowMs)은 지났지만 차단(blockMs=100s)은 아직 안 끝난 시점.
  const later = now + 5_000;
  limiter.recordFailure("other-ip", later); // sweep 트리거

  assert.equal(limiter.isBlocked("blocked-ip", later), true);
  assert.equal(limiter.size, 2); // blocked-ip 는 살아있고 other-ip 도 새로 생겼다
});

test("상한(maxEntries)을 넘으면 sweep 주기와 무관하게 항상 상한 이하로 유지한다", () => {
  const limiter = new AuthRateLimiter({
    maxFailures: 100, windowMs: 1_000_000, blockMs: 1_000_000, sweepIntervalMs: 1_000_000, maxEntries: 10,
  });
  const now = 1_000_000;

  // sweep 은 안 지날 만큼 짧은 간격으로 20개 서로 다른 출처가 실패한다.
  for (let i = 0; i < 20; i += 1) limiter.recordFailure(`ip-${i}`, now + i);

  assert.ok(limiter.size <= 10);
});

test("상한 청소 뒤에도 가장 먼저 실패했던 출처들은 사라진다", () => {
  const limiter = new AuthRateLimiter({
    maxFailures: 2, windowMs: 1_000_000, blockMs: 1_000_000, sweepIntervalMs: 1_000_000, maxEntries: 3,
  });
  const now = 1_000_000;

  // "oldest" 는 같은 창 안에서 두 번 실패해 차단 상태(blockedUntil 이 먼 미래)가 된다.
  // 이렇게 해 두면, 나중에 엔트리 자체가 지워졌는지를 isBlocked 로 분명히 구분할 수 있다
  // (지워지지 않았다면 여전히 차단 중이라 true 가 나와야 한다).
  limiter.recordFailure("oldest", now);
  limiter.recordFailure("oldest", now);
  limiter.recordFailure("second", now + 1);
  limiter.recordFailure("third", now + 2);
  assert.equal(limiter.size, 3);
  assert.equal(limiter.isBlocked("oldest", now + 2), true);

  // 네 번째가 들어오면 상한(3)을 넘으므로 windowStart 가 가장 오래된 "oldest" 가 지워져야 한다.
  limiter.recordFailure("fourth", now + 3);
  assert.equal(limiter.size, 3);
  assert.equal(limiter.isBlocked("oldest", now + 3), false); // 차단 상태까지 통째로 사라졌다
});
