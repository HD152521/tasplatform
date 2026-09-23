import { test } from "node:test";
import assert from "node:assert/strict";
import { PRODUCT_CATALOG, mergeCatalog, type CatalogEntry } from "../lib/productCatalog.ts";

const keyOf = (c: CatalogEntry): string => `${c.productId}:${c.componentId}`;

test("내장 목록은 비어 있지 않고 id 가 다 있다", () => {
  assert.ok(PRODUCT_CATALOG.length > 40, String(PRODUCT_CATALOG.length));
  for (const c of PRODUCT_CATALOG) {
    // id 는 포털이 쓰는 실제 값이다. 0 이나 NaN 이 섞이면 다른 제품으로 등록된다.
    assert.ok(Number.isInteger(c.productId) && c.productId > 0, c.productName);
    assert.ok(Number.isInteger(c.componentId) && c.componentId > 0, c.componentName);
    assert.notEqual(c.productName.trim(), "");
    assert.notEqual(c.componentName.trim(), "");
  }
});

test("같은 조합이 두 번 들어 있지 않다", () => {
  const seen = new Set(PRODUCT_CATALOG.map(keyOf));
  assert.equal(seen.size, PRODUCT_CATALOG.length);
});

test("우리 주력 제품이 들어 있다", () => {
  const names = new Set(PRODUCT_CATALOG.map((c) => c.productName));
  for (const want of [
    "VMware Tanzu Application Service",
    "VMware Tanzu Platform - Cloud Foundry",
    "Operations Manager",
  ]) {
    assert.ok(names.has(want), want);
  }
});

/* ------------------------------------------------------------------ *
 * 합치기
 * ------------------------------------------------------------------ */

test("DB 가 비면 내장 목록이 통째로 나온다", () => {
  const merged = mergeCatalog([]);
  assert.equal(merged.length, PRODUCT_CATALOG.length);
  assert.ok(merged.every((c) => c.used === 0));
});

// 예전에는 "비었을 때만" 내장 목록을 썼다. 쓸모없는 조합이 몇 개만 있어도
// 내장 목록이 안 켜져 정작 필요한 Tanzu 제품을 고를 수 없었다.
test("DB 에 쓸모없는 조합만 있어도 내장 목록이 함께 나온다", () => {
  const junk = [{
    productId: 2, productName: "Support Portal",
    componentId: 8, componentName: "Support Online General Assistance", used: 3,
  }];
  const merged = mergeCatalog(junk);
  assert.ok(merged.length > junk.length + 40, String(merged.length));
  assert.ok(merged.some((c) => c.productName === "VMware Tanzu Application Service"));
});

test("겹치는 조합은 DB 쪽을 남긴다", () => {
  const first = PRODUCT_CATALOG[0];
  assert.ok(first);
  const fromDb = [{ ...first, used: 99 }];
  const merged = mergeCatalog(fromDb);
  const hits = merged.filter((c) => keyOf(c) === keyOf(first));
  assert.equal(hits.length, 1, "같은 조합이 두 번 나오면 안 된다");
  // used 가 살아 있어야 많이 쓰는 것이 위로 온다.
  assert.equal(hits[0]?.used, 99);
});

test("DB 것이 앞에 온다", () => {
  const junk = [{
    productId: 2, productName: "Support Portal",
    componentId: 8, componentName: "Support Online General Assistance", used: 3,
  }];
  const merged = mergeCatalog(junk);
  assert.equal(merged[0]?.productId, 2);
});
