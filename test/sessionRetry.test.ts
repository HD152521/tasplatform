/**
 * "세션이 죽었으면 최신본으로 한 번만 다시" 를 잠근다.
 *
 * 이 판단이 틀리면 조용히 어긋난다 — 재시도를 안 하면 사람은 아무것도 할 수 없는
 * "세션이 만료되었습니다" 를 보고(수집기가 재로그인한 직후의 본문 이미지가 그랬다),
 * 여러 번 되풀이하면 사람을 세워 둔 채 같은 401 을 반복한다. 둘 다 화면에는 "실패"
 * 한 줄로만 보여서 눈으로는 어느 쪽인지 알 수 없다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { retryOnDeadSession } from "../lib/sessionRetry.ts";

/** 호출 횟수를 세면서 정해진 값을 차례로 돌려주는 send. */
function sender<T>(...values: T[]): { send: () => Promise<T>; calls: () => number } {
  let calls = 0;
  return {
    send: async () => {
      const value = values[Math.min(calls, values.length - 1)] as T;
      calls += 1;
      return value;
    },
    calls: () => calls,
  };
}

test("세션 문제가 없으면 한 번만 보낸다", async () => {
  const { send, calls } = sender("ok");
  const result = await retryOnDeadSession("t", {
    send,
    deadSession: () => false,
    refresh: async () => assert.fail("세션이 멀쩡한데 최신본을 끌어왔다"),
  });
  assert.equal(result, "ok");
  assert.equal(calls(), 1);
});

test("세션이 죽고 최신본이 있으면 한 번 다시 보낸다", async () => {
  const { send, calls } = sender("dead", "alive");
  let refreshed = 0;
  const result = await retryOnDeadSession("t", {
    send,
    deadSession: (v) => v === "dead",
    refresh: async () => {
      refreshed += 1;
      return true;
    },
  });
  assert.equal(result, "alive");
  assert.equal(calls(), 2);
  assert.equal(refreshed, 1);
});

test("끌어올 최신본이 없으면 다시 보내지 않는다", async () => {
  // 같은 쿠키로 또 보내면 또 401 이다. 사람을 그만큼 더 기다리게 할 뿐이다.
  const { send, calls } = sender("dead");
  const result = await retryOnDeadSession("t", {
    send,
    deadSession: (v) => v === "dead",
    refresh: async () => false,
  });
  assert.equal(result, "dead");
  assert.equal(calls(), 1);
});

test("두 번째도 죽어 있으면 그대로 돌려준다 — 세 번은 없다", async () => {
  const { send, calls } = sender("dead", "dead");
  const result = await retryOnDeadSession("t", {
    send,
    deadSession: (v) => v === "dead",
    refresh: async () => true,
  });
  assert.equal(result, "dead");
  assert.equal(calls(), 2);
});

test("세션과 무관한 실패는 재시도하지 않는다", async () => {
  // 404·500 을 재시도하면 같은 답을 두 번 받고 시간만 쓴다.
  const { send, calls } = sender("http-500");
  const result = await retryOnDeadSession("t", {
    send,
    deadSession: (v) => v === "dead",
    refresh: async () => assert.fail("세션 실패가 아닌데 끌어왔다"),
  });
  assert.equal(result, "http-500");
  assert.equal(calls(), 1);
});

test("다시 보낼 때 버리는 결과를 닫는다", async () => {
  // 응답 본문을 닫지 않으면 연결이 열린 채 남는다.
  const { send } = sender("dead", "alive");
  const discarded: string[] = [];
  await retryOnDeadSession("t", {
    send,
    deadSession: (v) => v === "dead",
    discard: (v) => {
      discarded.push(v);
    },
    refresh: async () => true,
  });
  assert.deepEqual(discarded, ["dead"]);
});

test("버리지 못해도 재시도는 한다", async () => {
  // 뒷정리 실패로 본 일을 막으면 안 된다.
  const { send, calls } = sender("dead", "alive");
  const result = await retryOnDeadSession("t", {
    send,
    deadSession: (v) => v === "dead",
    discard: () => {
      throw new Error("이미 닫혔다");
    },
    refresh: async () => true,
  });
  assert.equal(result, "alive");
  assert.equal(calls(), 2);
});

test("teamId 를 그대로 넘겨 그 팀의 세션을 끌어온다", async () => {
  const { send } = sender("dead", "alive");
  let asked = "";
  await retryOnDeadSession("acme", {
    send,
    deadSession: (v) => v === "dead",
    refresh: async (teamId) => {
      asked = teamId;
      return true;
    },
  });
  assert.equal(asked, "acme");
});
