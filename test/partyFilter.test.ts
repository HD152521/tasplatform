/**
 * 파티(고객사) 필터 검증.
 *
 * 계정이 여러 고객사 SR 을 함께 보는 상황에서, 우리 담당(NH BANK=15588968)만
 * 남기고 KB Life 등은 빼야 한다. partySiteNumber 로 판정한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { filterAllowedParties } from "../lib/partyFilter.ts";
import type { SearchResultItem } from "../lib/types.ts";

function item(requestId: number, partyName: string, partySiteNumber: string): SearchResultItem {
  return {
    requestId,
    requestIdFormatted: String(requestId),
    requestDesc: "t",
    statusAliasName: "Open",
    priorityName: "P3",
    subCategoryName: "TAS",
    partyName,
    partySiteNumber,
    createdOn: "",
    lastUpdated: "",
  };
}

const NH = item(1, "NONGHYUP BANK (NH BANK)", "15588968");
const KB = item(2, "KB Life Insurance", "99999999");
const NH2 = item(3, "NONGHYUP BANK (NH BANK)", "15588968");

test("허용 사이트(NH)만 남기고 다른 고객사(KB)는 뺀다", () => {
  const out = filterAllowedParties([NH, KB, NH2], ["15588968"]);
  assert.deepEqual(out.map((c) => c.requestId), [1, 3]);
});

test("화이트리스트가 비면 필터를 끄고 전부 통과시킨다", () => {
  const out = filterAllowedParties([NH, KB], []);
  assert.equal(out.length, 2);
});

test("여러 사이트를 허용할 수 있다", () => {
  const out = filterAllowedParties([NH, KB], ["15588968", "99999999"]);
  assert.equal(out.length, 2);
});

test("partySiteNumber 앞뒤 공백을 무시하고 매칭한다", () => {
  const spaced = item(4, "NONGHYUP BANK (NH BANK)", " 15588968 ");
  const out = filterAllowedParties([spaced], ["15588968"]);
  assert.equal(out.length, 1);
});

test("partySiteNumber 가 비었으면(허용목록 있을 때) 제외한다", () => {
  const empty = item(5, "Unknown", "");
  const out = filterAllowedParties([empty, NH], ["15588968"]);
  assert.deepEqual(out.map((c) => c.requestId), [1]);
});
