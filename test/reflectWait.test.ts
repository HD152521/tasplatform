/**
 * 쓴 것이 조회에 잡힐 때까지 다시 묻기.
 *
 * 답변을 보낸 직후 포털이 글을 받아 두고도 목록·스레드 조회에 바로 싣지 않는 순간이
 * 있다. 한 번만 받아 넣고 끝내면 "넣었는데 방금 쓴 글이 없는" 경우를 구분하지 못해,
 * 화면이 늘 "다음 수집 때 반영됩니다" 라고만 말했다 — 그걸 읽고 15분을 기다렸다.
 *
 * 이 판단이 틀려도 화면은 멀쩡해 보인다. 그래서 여기서 못박는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { untilReflected } from "../lib/reflectWait.ts";

/** 실제로 기다리지 않는다. 기다린 시간만 적어 둔다. */
function fakeSleep(log: number[]) {
  return async (ms: number): Promise<void> => { log.push(ms); };
}

test("첫 번에 들어오면 한 번만 끌어오고 기다리지 않는다", async () => {
  const slept: number[] = [];
  let pulls = 0;
  const got = await untilReflected(
    async () => { pulls += 1; },
    async () => true,
    { sleep: fakeSleep(slept) },
  );
  assert.equal(got, true);
  assert.equal(pulls, 1);
  // 대개 그 자리에서 들어온다. 늘 1초를 더 쓰게 만들 이유가 없다.
  assert.deepEqual(slept, []);
});

test("늦게 들어오면 기다렸다 다시 묻고 참을 돌려준다", async () => {
  const slept: number[] = [];
  let pulls = 0;
  const got = await untilReflected(
    async () => { pulls += 1; },
    async () => pulls >= 2,
    { waitMs: 500, sleep: fakeSleep(slept) },
  );
  assert.equal(got, true);
  assert.equal(pulls, 2);
  assert.deepEqual(slept, [500]);
});

/*
 * 몇 번 물어도 안 보이면 **거짓말하지 않는다.** 이 false 가 화면이 "아직 안 보인다"
 * 고 말할 근거다. true 로 둥글리면 사람이 없는 글을 찾는다.
 */
test("끝까지 안 들어오면 거짓을 돌려준다", async () => {
  let pulls = 0;
  const got = await untilReflected(
    async () => { pulls += 1; },
    async () => false,
    { tries: 3, waitMs: 1, sleep: async () => {} },
  );
  assert.equal(got, false);
  assert.equal(pulls, 3);
});

// 사람이 앞에서 기다리는 구간이다. 정한 횟수를 넘겨 끌지 않는다.
test("정한 횟수만 묻는다", async () => {
  let pulls = 0;
  await untilReflected(
    async () => { pulls += 1; },
    async () => false,
    { tries: 1, sleep: async () => {} },
  );
  assert.equal(pulls, 1);
});

test("횟수를 0 이나 음수로 줘도 한 번은 묻는다", async () => {
  for (const tries of [0, -5]) {
    let pulls = 0;
    await untilReflected(async () => { pulls += 1; }, async () => false, {
      tries, sleep: async () => {},
    });
    assert.equal(pulls, 1, `tries=${tries}`);
  }
});

/*
 * 끌어오기가 한 번 터진 것이 다음 번 실패를 뜻하지 않는다. 그리고 쓰기는 이미 끝나
 * 되돌릴 수 없다 — 여기서 터뜨리면 사용자가 "전송 실패" 로 읽고 다시 보낸다.
 */
test("끌어오기가 터져도 멈추지 않고 다시 묻는다", async () => {
  let pulls = 0;
  const got = await untilReflected(
    async () => {
      pulls += 1;
      if (pulls === 1) throw new Error("망 오류");
    },
    async () => pulls >= 2,
    { waitMs: 1, sleep: async () => {} },
  );
  assert.equal(got, true);
  assert.equal(pulls, 2);
});

test("끝까지 터져도 예외를 올리지 않는다", async () => {
  await assert.doesNotReject(async () => {
    const got = await untilReflected(
      async () => { throw new Error("계속 망 오류"); },
      async () => false,
      { tries: 2, sleep: async () => {} },
    );
    assert.equal(got, false);
  });
});

// 확인 쪽이 터지는 것은 **DB 가 안 열리는** 등 진짜 문제다. 삼키면 원인이 묻힌다.
test("확인이 터지면 그 예외는 올린다", async () => {
  await assert.rejects(
    () => untilReflected(async () => {}, async () => { throw new Error("DB 오류"); }),
    /DB 오류/,
  );
});
