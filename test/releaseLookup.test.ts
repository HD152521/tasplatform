/**
 * 릴리스 조회 실패를 구분한다.
 *
 * 전에는 401 과 403 을 한 문장으로 묶어 **둘 다 "세션이 만료되었습니다. 다시
 * 로그인하세요."** 라고 했다. 그런데 사람이 할 일이 정반대다 —
 *
 *   401 → 세션이 죽었다. 다시 로그인하면 풀린다.
 *   403 → 로그인은 되어 있고 **그 요청을 할 권한이 없다.** 로그인해도 그대로다.
 *
 * 묶어 두니 403 일 때 로그인 화면만 오가며 "세션이 저장돼 있습니다" 와 "만료되었습니다"
 * 를 번갈아 보게 됐다. 그 일이 실제로 났으므로 시험으로 못박는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ReleaseLookupError, findReleases } from "../lib/releaseList.ts";

/** 주어진 상태코드와 본문만 돌려주는 가짜 포털. */
function fakeClient(status: number, body = "{}") {
  return {
    post: async () => ({
      status: () => status,
      text: async () => body,
    }),
    // findReleases 는 post 만 쓴다. 나머지는 쓰이면 바로 터지게 둔다.
    get: () => {
      throw new Error("쓰이지 않아야 한다");
    },
  } as never;
}

test("401 은 세션 문제로 본다 — 다시 로그인하면 풀린다", async () => {
  await assert.rejects(
    () => findReleases(fakeClient(401), 123, ""),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseLookupError);
      assert.equal(error.code, "session");
      assert.equal(error.status, 401);
      assert.match(error.message, /다시 로그인/);
      return true;
    },
  );
});

test("403 은 권한 문제로 본다 — 다시 로그인해도 안 풀린다고 말한다", async () => {
  await assert.rejects(
    () => findReleases(fakeClient(403), 123, ""),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseLookupError);
      assert.equal(error.code, "forbidden");
      assert.equal(error.status, 403);
      // 이 문장이 핵심이다. "다시 로그인하세요" 로 보내면 영원히 헛돈다.
      assert.ok(error.message.includes("다시 로그인해도 풀리지 않습니다"));
      assert.ok(error.message.includes("403"));
      // 직접 입력이라는 길을 알려 준다 — 막힌 채로 두지 않는다.
      assert.ok(error.message.includes("직접 입력"));
      return true;
    },
  );
});

test("그 밖의 상태는 단정하지 않고 숫자를 그대로 보여 준다", async () => {
  await assert.rejects(
    () => findReleases(fakeClient(502), 123, ""),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseLookupError);
      assert.equal(error.code, "http");
      assert.equal(error.status, 502);
      assert.match(error.message, /HTTP 502/);
      // 세션 이야기를 꺼내지 않는다.
      assert.ok(!error.message.includes("로그인"));
      return true;
    },
  );
});

test("code 를 안 주면 session 으로 둔다(기존 호출부 호환)", () => {
  const error = new ReleaseLookupError("무엇이든");
  assert.equal(error.code, "session");
  assert.equal(error.status, 0);
});
