/**
 * Release 목록 조회·대조 규칙.
 *
 * 이게 틀리면 **엉뚱한 제품의 버전으로 SR 이 올라간다.** 실제로 그랬다 — 템플릿의
 * `releaseId: 798` 은 GemFire 10.4.2 인데 TAS 케이스에 그대로 실려 나갔다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ReleaseLookupError,
  findReleases,
  matchRelease,
  versionCandidates,
  type Release,
} from "../lib/releaseList.ts";
import {
  categoryIdOf,
  knownProductIds,
  selectableProducts,
} from "../lib/productCategory.ts";

/** 조회 응답을 흉내 내는 클라이언트. */
function stub(status: number, body: string) {
  const calls: Array<Record<string, string>> = [];
  return {
    calls,
    client: {
      post: async (_url: string, options: { multipart: Record<string, string> }) => {
        calls.push(options.multipart);
        return { status: () => status, text: async () => body };
      },
    },
  };
}

const OK = JSON.stringify({
  status: "success",
  data: [
    { releaseId: 111283, releaseDesc: "2603.4.3" },
    { releaseId: 14823, releaseDesc: "2412.10.14" },
    // 야간 빌드. 사람이 고르는 버전이 아니다 — 걸러져야 한다.
    { releaseId: 110820, releaseDesc: "2026-03-02_080902" },
    { releaseId: 11304, releaseDesc: "2402.8.20.1" },
    // 쓸 수 없는 줄
    { releaseId: 0, releaseDesc: "버려야 함" },
    { releaseId: 777, releaseDesc: "   " },
  ],
});

// ---------------------------------------------------------------- 조회

test("야간 빌드와 쓸 수 없는 줄을 걸러낸다", async () => {
  const { client } = stub(200, OK);
  const rows = await findReleases(client, 3561);
  assert.deepEqual(rows, [
    { releaseId: 111283, releaseDesc: "2603.4.3" },
    { releaseId: 14823, releaseDesc: "2412.10.14" },
    { releaseId: 11304, releaseDesc: "2402.8.20.1" },
  ]);
});

/*
 * 포털이 쓰는 그 조회를 그대로 흉내 내야 한다. dataApiName 이나 키 이름이 틀리면
 * **빈 목록이 성공으로** 돌아와, 그 제품에 release 가 없는 것처럼 보인다.
 */
test("포털과 같은 모양으로 묻는다", async () => {
  const { client, calls } = stub(200, OK);
  await findReleases(client, 3571, "10.4");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.dataApiName, "itemReleaseList");
  const data = JSON.parse(calls[0]?.data ?? "{}") as Record<string, unknown>;
  assert.equal(data.categoryId, 3571);
  assert.equal(data.releaseId, "10.4", "검색어는 releaseId 키로 보낸다");
  assert.equal(typeof data.limit, "number");
  assert.equal(data.offset, 0);
});

/*
 * 실패를 빈 배열로 삼키지 않는다. 삼키면 "그 제품에 release 가 없다" 와 구분이 안 되고
 * 사람은 왜 고를 것이 없는지 알 수 없다.
 */
test("실패는 던진다", async () => {
  for (const [status, body] of [[401, "{}"], [500, "{}"], [200, "깨진 JSON"],
    [200, '{"data":"배열아님"}']] as Array<[number, string]>) {
    const { client } = stub(status, body);
    await assert.rejects(() => findReleases(client, 3561), ReleaseLookupError,
      `HTTP ${status} / ${body} 는 던져야`);
  }
});

test("세션 만료는 그렇게 알린다", async () => {
  const { client } = stub(401, "{}");
  await assert.rejects(() => findReleases(client, 3561), /세션이 만료/);
});

// ---------------------------------------------------------------- 버전 추출

test("글에서 버전처럼 보이는 토막을 뽑는다", () => {
  assert.deepEqual(versionCandidates("TPCF 10.4.2 에서 앱이 죽습니다"), ["10.4.2"]);
  assert.deepEqual(versionCandidates("2402.8.20.1 로 올린 뒤"), ["2402.8.20.1"]);
  assert.deepEqual(versionCandidates("버전 얘기 없음"), []);
  // 한 자리 숫자는 버전이 아니다(케이스 번호·수량과 섞인다).
  assert.deepEqual(versionCandidates("앱 3개가 죽습니다"), []);
});

/*
 * **긴 것부터** 돌려준다. `10.4.2` 가 적혀 있으면 `10.4` 보다 먼저 맞춰 봐야 한다 —
 * 짧은 쪽을 먼저 쓰면 10.4.10 같은 다른 버전에 걸린다.
 */
test("더 구체적인 버전을 먼저 돌려준다", () => {
  const got = versionCandidates("10.4 대에서, 정확히는 10.4.2 입니다");
  assert.deepEqual(got, ["10.4.2", "10.4"]);
});

// ---------------------------------------------------------------- 대조

const RELEASES: Release[] = [
  { releaseId: 111918, releaseDesc: "10.4.10" },
  { releaseId: 798, releaseDesc: "10.4.2" },
  { releaseId: 15260, releaseDesc: "10.4.0" },
];

test("적어 둔 버전과 정확히 같은 것을 고른다", () => {
  assert.equal(matchRelease(RELEASES, "GemFire 10.4.2 에서")?.releaseId, 798);
  assert.equal(matchRelease(RELEASES, "10.4.10 으로 올린 뒤")?.releaseId, 111918);
});

/*
 * **정확히 같은 것만** 받는다. `10.4` 로 `10.4.10` 을 골라 주면 다른 버전으로
 * 등록된다 — 비슷한 것을 골라 주는 편의가 틀린 등록보다 낫지 않다.
 */
test("비슷한 것으로 대충 맞추지 않는다", () => {
  assert.equal(matchRelease(RELEASES, "10.4 대입니다"), null);
  assert.equal(matchRelease(RELEASES, "10.5.1 입니다"), null);
  assert.equal(matchRelease(RELEASES, "버전 얘기 없음"), null);
  assert.equal(matchRelease([], "10.4.2"), null);
});

// ---------------------------------------------------------------- 제품 분류

/*
 * categoryId 는 **지어낼 수 없다.** 모르는 제품이면 null 을 주고 부르는 쪽이 멈춰야
 * 한다. 템플릿 값(3561=TAS)으로 메우던 것이 모순된 조합을 만든 원인이다.
 */
test("아는 제품의 categoryId 를 준다", () => {
  assert.equal(categoryIdOf(4322), 3561, "TAS");
  assert.equal(categoryIdOf(4332), 3571, "GemFire");
  assert.equal(categoryIdOf(4801), 4040, "TPCF");
  assert.equal(categoryIdOf(4301), 3540, "Operations Manager");
});

test("모르는 제품은 null 이다", () => {
  assert.equal(categoryIdOf(999999), null);
  assert.equal(categoryIdOf(0), null);
  assert.equal(categoryIdOf(-1), null);
});

/*
 * 고를 수 있게 남은 제품은 **전부** categoryId 를 알아야 한다. 하나라도 비면 그
 * 제품으로 등록을 시도하다 포털에서 거절당하고, 사람은 이유를 알 수 없다.
 */
test("고를 수 있는 제품은 전부 categoryId 를 갖는다", async () => {
  const { PRODUCT_CATALOG } = await import("../lib/productCatalog.ts");
  const known = new Set(knownProductIds());
  const missing = selectableProducts(PRODUCT_CATALOG)
    .map((c) => c.productId)
    .filter((id) => !known.has(id));
  assert.deepEqual(missing, []);
});

/*
 * 그리고 실제로 **걸러진다.** 카탈로그에는 포털이 더 이상 제공하지 않는 제품이
 * 섞여 있다(과거 케이스에서 들어온다). 그쪽으로는 등록할 수 없다.
 */
test("포털이 제공하지 않는 제품은 선택지에서 빠진다", async () => {
  const { PRODUCT_CATALOG } = await import("../lib/productCatalog.ts");
  const before = new Set(PRODUCT_CATALOG.map((c) => c.productId));
  const after = new Set(selectableProducts(PRODUCT_CATALOG).map((c) => c.productId));
  assert.ok(after.size < before.size, "걸러진 것이 하나도 없다");
  // 실측으로 확인된 단종·타종류 제품들
  for (const dead of [4284, 4551, 4299, 4550, 2, 4508]) {
    assert.ok(before.has(dead), `카탈로그에 ${dead} 가 없다 — 시험 전제가 바뀌었다`);
    assert.ok(!after.has(dead), `${dead} 가 선택지에 남았다`);
  }
  // 정작 쓰는 제품은 남아야 한다.
  for (const alive of [4322, 4801, 4301, 4332]) {
    assert.ok(after.has(alive), `${alive} 가 선택지에서 빠졌다`);
  }
});
