/**
 * 수집기가 돌고 있는가 — 판정.
 *
 * 이 판정이 화면의 안내를 가른다. 틀리면 둘 중 하나가 된다 —
 *   아무 문제 없는 날에 "수집기가 멈췄다" 고 말해 사람을 VM 으로 보낸다.
 *   정말 멈춘 날에 "요청하면 됩니다" 라고 말해 영원히 기다리게 한다.
 * 둘 다 조용한 고장이라 시험으로 잠근다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_COLLECT_INTERVAL_MS,
  canAskCollector,
  judgeCollector,
} from "../lib/collectorHealth.ts";

const INTERVAL = DEFAULT_COLLECT_INTERVAL_MS; // 15분
/** 2026-11-24(화) 14:00 로컬시. 운영 시간대("8-20") 안이다. */
const NOON = new Date(2026, 10, 24, 14, 0, 0).getTime();
/** 같은 날 새벽 3시. "8-20" 밖이다. */
const NIGHT = new Date(2026, 10, 24, 3, 0, 0).getTime();

test("방금 돌았으면 정상이다", () => {
  const judged = judgeCollector({
    lastRunAt: NOON - 60_000,
    now: NOON,
    intervalMs: INTERVAL,
    hoursSpec: "8-20",
  });
  assert.equal(judged.state, "ok");
  assert.equal(canAskCollector(judged.state), true);
});

test("간격을 조금 넘겨도 정상이다 — 한 회차는 몇 분씩 걸린다", () => {
  // 간격 한 배로 판정하면 회차가 길어진 날마다 "멈췄다" 가 뜬다.
  const judged = judgeCollector({
    lastRunAt: NOON - INTERVAL * 2,
    now: NOON,
    intervalMs: INTERVAL,
    hoursSpec: "8-20",
  });
  assert.equal(judged.state, "ok");
});

test("세 배를 넘기면 멈춘 것으로 본다", () => {
  const judged = judgeCollector({
    lastRunAt: NOON - INTERVAL * 3 - 1,
    now: NOON,
    intervalMs: INTERVAL,
    hoursSpec: "8-20",
  });
  assert.equal(judged.state, "stalled");
  // 멈춴 수집기에 요청을 남기면 줄에만 쌓인다 — 버튼을 보여 주면 안 된다.
  assert.equal(canAskCollector(judged.state), false);
});

test("운영 시간대 밖이면 조용한 것이 정상이다", () => {
  /*
   * 이게 없으면 매일 아침 "12시간 동안 멈췄다" 가 뜬다 — worker 는 운영 시간대 밖에서
   * 정기 회차를 돌리지 않는다.
   */
  const judged = judgeCollector({
    lastRunAt: NIGHT - 8 * 3_600_000,
    now: NIGHT,
    intervalMs: INTERVAL,
    hoursSpec: "8-20",
  });
  assert.equal(judged.state, "resting");
  // 자는 동안에도 요청은 집어간다(collector/worker.ts 의 운영 시간대 밖 분기).
  assert.equal(canAskCollector(judged.state), true);
});

test("운영 시간대를 모르면 24시간으로 본다 — 그 사실을 함께 알린다", () => {
  const judged = judgeCollector({
    lastRunAt: NIGHT - 8 * 3_600_000,
    now: NIGHT,
    intervalMs: INTERVAL,
    hoursSpec: "",
  });
  assert.equal(judged.state, "stalled");
  // 화면이 "운영 시간대 밖이면 정상입니다" 를 덧붙일 수 있어야 한다.
  assert.equal(judged.knowsHours, false);
});

test("회차 기록이 없으면 '한 번도 안 돌았다' 다 — 쉬는 중이 아니다", () => {
  // 밤이어도 이건 설치가 안 끝났거나 수집기가 한 번도 뜨지 못한 것이다.
  const judged = judgeCollector({
    lastRunAt: null,
    now: NIGHT,
    intervalMs: INTERVAL,
    hoursSpec: "8-20",
  });
  assert.equal(judged.state, "never");
  assert.equal(judged.quietMs, 0);
  assert.equal(canAskCollector(judged.state), false);
});

test("간격이 깨진 값이면 기본 간격으로 떨어진다", () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const judged = judgeCollector({
      lastRunAt: NOON - 60_000,
      now: NOON,
      intervalMs: bad,
      hoursSpec: "8-20",
    });
    assert.equal(judged.intervalMs, DEFAULT_COLLECT_INTERVAL_MS, String(bad));
    assert.equal(judged.state, "ok");
  }
});

test("시계가 어긋나 미래 시각이 와도 음수가 되지 않는다", () => {
  // 웹과 수집기는 다른 기계다. 음수가 흘러가면 "−3분 동안 멈췄다" 가 찍힌다.
  const judged = judgeCollector({
    lastRunAt: NOON + 60_000,
    now: NOON,
    intervalMs: INTERVAL,
    hoursSpec: "8-20",
  });
  assert.equal(judged.quietMs, 0);
  assert.equal(judged.state, "ok");
});
