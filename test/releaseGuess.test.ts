/**
 * 글에서 버전 집기.
 *
 * 규칙은 하나다 — **애매하면 비운다.** 틀린 버전으로 SR 이 올라가면 담당 엔지니어가
 * 엉뚱한 환경을 들여다보고, 그 사실은 답변이 오고 나서야 드러난다. 비어 있는 것은
 * 사람이 고르면 되는 일이다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { guessRelease } from "../lib/releaseGuess.ts";
import { categoryIdOf, knownProductIds } from "../lib/productCategory.ts";
import type { ReleaseLookupClient } from "../lib/releaseList.ts";

const PRODUCT = knownProductIds()[0]!;

/** 포털 대신 답하는 가짜. 어떤 검색어로 물었는지도 기록한다. */
function fakePortal(
  rows: Array<{ releaseId: number; releaseDesc: string }>,
  asked: string[] = [],
): ReleaseLookupClient {
  return {
    post: async (_url, options) => {
      const data = JSON.parse(options.multipart.data ?? "{}") as { releaseId?: string; categoryId?: number };
      asked.push(String(data.releaseId ?? ""));
      const q = String(data.releaseId ?? "");
      const hit = rows.filter((r) => r.releaseDesc.includes(q));
      return {
        status: () => 200,
        ok: () => true,
        json: async () => ({ status: "success", data: hit }),
        text: async () => JSON.stringify({ status: "success", data: hit }),
      };
    },
  };
}

test("글에 적힌 버전이 목록에 그대로 있으면 집는다", async () => {
  const client = fakePortal([{ releaseId: 798, releaseDesc: "10.4.2" }]);
  const hit = await guessRelease(client, PRODUCT, "TPCF 10.4.2 에서 재현됩니다");
  assert.deepEqual(hit, { releaseId: 798, releaseDesc: "10.4.2" });
});

/*
 * **정확히 일치만 받는다.** `10.4` 라고 적혀 있고 목록에 `10.4.2`·`10.4.3` 만 있으면
 * 둘 중 하나를 찍는 것은 추측이다.
 */
test("비슷한 것은 고르지 않는다", async () => {
  const client = fakePortal([
    { releaseId: 798, releaseDesc: "10.4.2" },
    { releaseId: 6402, releaseDesc: "10.4.3" },
  ]);
  assert.equal(await guessRelease(client, PRODUCT, "10.4 환경입니다"), null);
});

test("버전이 안 적혀 있으면 비운다", async () => {
  const client = fakePortal([{ releaseId: 798, releaseDesc: "10.4.2" }]);
  assert.equal(await guessRelease(client, PRODUCT, "로그인이 안 됩니다"), null);
});

// 긴 것부터 본다 — "10.4.2" 가 있으면 "10.4" 로 먼저 묻지 않는다.
test("긴 버전부터 묻는다", async () => {
  const asked: string[] = [];
  const client = fakePortal([{ releaseId: 1, releaseDesc: "2.7" }], asked);
  await guessRelease(client, PRODUCT, "10.4.2 와 2.7 을 함께 씁니다");
  assert.equal(asked[0], "10.4.2", `처음 물은 것: ${asked.join(", ")}`);
});

/*
 * 세션이 끊겨도 **던지지 않는다.** 버전을 못 집는 것 때문에 간단히 올리기 전체가
 * 실패하면, 7~8초 걸려 만든 초안까지 버리게 된다.
 */
test("포털이 실패해도 던지지 않는다", async () => {
  const dead: ReleaseLookupClient = {
    post: async () => ({
      status: () => 401,
      ok: () => false,
      json: async () => ({}),
      text: async () => "",
    }),
  };
  let hit: unknown = "not-set";
  await assert.doesNotReject(async () => { hit = await guessRelease(dead, PRODUCT, "10.4.2"); });
  assert.equal(hit, null);
});

// 분류 표에 없는 제품은 포털에 묻지도 않는다 — 그 제품은 등록 자체가 거절된다.
test("분류를 모르는 제품은 묻지 않는다", async () => {
  const asked: string[] = [];
  const client = fakePortal([{ releaseId: 798, releaseDesc: "10.4.2" }], asked);
  assert.equal(categoryIdOf(999_999), null, "전제: 표에 없는 제품");
  assert.equal(await guessRelease(client, 999_999, "10.4.2"), null);
  assert.deepEqual(asked, [], "포털에 물었다");
});
