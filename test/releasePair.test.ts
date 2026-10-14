/**
 * 제품·릴리스 짝 규칙.
 *
 * 이 판정이 틀리면 **조용히 엉뚱한 버전으로 SR 이 올라간다.** 실제로 그랬다 — 분류는
 * TAS 로, 릴리스는 `10.4.2` 로 박혀 있어서 어떤 제품을 고르든 그 조합으로 등록됐고,
 * 화면의 Prod Release 칸은 필수로 표시된 채 값이 버려졌다. 거절보다 나쁜 실패다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRelease } from "../lib/releasePair.ts";
import { categoryIdOf, knownProductIds } from "../lib/productCategory.ts";

const PRODUCT = knownProductIds()[0]!;
const CATEGORY = categoryIdOf(PRODUCT)!;

test("제품과 릴리스가 다 있으면 짝이 된다", () => {
  assert.deepEqual(resolveRelease(PRODUCT, 798), {
    ok: true, categoryId: CATEGORY, releaseId: 798,
  });
});

/*
 * **분류를 화면에서 받지 않는다.** 제품에서 되찾으므로 "제품은 A, 분류는 B" 가 될 수 없다.
 */
test("분류는 제품에서 되찾는다", () => {
  for (const id of knownProductIds().slice(0, 5)) {
    const r = resolveRelease(id, 798);
    assert.equal(r.ok && r.categoryId, categoryIdOf(id));
  }
});

/*
 * ## 못 고르면 **등록하지 않는다**
 *
 * 한때 "못 고르면 분류·릴리스를 둘 다 안 보내고 템플릿 값으로 두면 안전하다" 고 봤는데
 * 틀렸다. 제품(`subCategoryId`)은 무조건 덮어써지므로, 그러면 "제품은 GemFire, 분류는
 * TAS, 릴리스는 10.4.2" 처럼 세 값이 서로 다른 제품을 가리키는 요청이 나간다.
 */
test("릴리스를 고르지 않았으면 no_release 로 거절한다", () => {
  for (const bad of [undefined, 0, -1, "10.4.2", "", "abc", null, {}, [], 1.5, NaN, Infinity]) {
    const r = resolveRelease(PRODUCT, bad);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 를 받았다`);
    assert.equal(r.ok === false && r.code, "no_release");
  }
});

test("제품이 없거나 표에 없으면 unknown_product 로 거절한다", () => {
  for (const bad of [undefined, 0, -1, "", "abc", null]) {
    const r = resolveRelease(bad, 798);
    assert.equal(r.ok === false && r.code, "unknown_product", `${JSON.stringify(bad)}`);
  }
  assert.equal(categoryIdOf(999_999), null, "전제: 이 제품은 표에 없다");
  const unknown = resolveRelease(999_999, 798);
  assert.equal(unknown.ok === false && unknown.code, "unknown_product");
});

/*
 * 이유를 구분하는 까닭: 사람이 할 일이 다르다. 릴리스는 고르면 되고, 표에 없는 제품은
 * 포털에서 올려야 한다. 한 가지 문구로 뭉치면 엉뚱한 곳을 판다.
 */
test("거절 문구가 할 일을 말한다", () => {
  const noRelease = resolveRelease(PRODUCT, 0);
  assert.match(noRelease.ok === false ? noRelease.message : "", /Prod Release/);
  const noProduct = resolveRelease(999_999, 798);
  assert.match(noProduct.ok === false ? noProduct.message : "", /포털/);
});

// 숫자 모양의 문자열은 화면에서 그대로 올 수 있다(쿼리스트링·JSON). 받아 준다.
test("숫자 모양의 문자열은 받는다", () => {
  assert.deepEqual(resolveRelease(String(PRODUCT), "798"), {
    ok: true, categoryId: CATEGORY, releaseId: 798,
  });
});
