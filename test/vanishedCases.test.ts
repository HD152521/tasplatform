/**
 * 목록에서 **사라진** 진행중 케이스 골라내기.
 *
 * 포털의 진행중 조회는 `End Customer Status != Closed` 로 거른다
 * (collector/payloads/search.json). 그래서 케이스가 닫히면 **조회 결과에서 빠진다** —
 * "상태가 Closed 로 바뀐 행"이 오는 게 아니다. 수집기는 조회로 받은 건만 쓰므로
 * (collector/collect.ts), 빠진 건은 마지막으로 본 상태(`Pending Customer` 등)로
 * 영영 굳는다. 실측: 포털에서 Closed 인 건이 우리 화면 진행중에 8건 남아 있었다.
 *
 * 굳으면 자동 게시가 영영 안 돈다 — 대상 조회가 `status IN ('closed','resolved')` 를
 * 보기 때문이다(lib/autopublish.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectVanishedCases } from "../lib/diff.ts";
import type { SearchResultItem } from "../lib/types.ts";

/** 조회 결과 한 줄. 비교에 쓰는 칸만 채운다. */
const item = (requestId: number): SearchResultItem => ({
  requestId,
  requestIdFormatted: String(requestId),
  requestDesc: "",
  statusAliasName: "Pending Support",
  priorityName: "",
  subCategoryName: "",
  partyName: "",
  partySiteNumber: "",
  createdOn: "",
  lastUpdated: "",
});

test("조회에 없는 진행중 건을 집는다", () => {
  const got = selectVanishedCases([11, 22, 33], [item(11), item(33)]);
  assert.deepEqual(got, [22]);
});

test("조회에 다 있으면 아무것도 집지 않는다", () => {
  assert.deepEqual(selectVanishedCases([11, 22], [item(11), item(22)]), []);
});

/*
 * **가장 중요한 안전장치.** 조회가 통째로 실패하거나 빈 응답인 회차에 "전부 사라졌다" 고
 * 보면, 살아 있는 케이스를 모두 닫아 버린다. 되돌리려면 손으로 고쳐야 하고, 그 사이
 * 자동 게시가 멀쩡한 건을 Confluence 로 올린다.
 */
test("조회 결과가 비면 아무것도 집지 않는다", () => {
  assert.deepEqual(selectVanishedCases([11, 22, 33], []), []);
});

test("진행중이 없으면 빈 결과다", () => {
  assert.deepEqual(selectVanishedCases([], [item(11)]), []);
});

/*
 * 한 회차에 확인할 수를 묶는다. 한 건마다 상세 조회 한 번이 나가므로, 오래 쉬었다가
 * 돌린 회차가 수십 건을 한 번에 때리지 않게 한다. 남은 건은 다음 회차가 집는다.
 */
test("한 회차 상한을 넘기지 않는다", () => {
  const got = selectVanishedCases([1, 2, 3, 4, 5], [], 2);
  assert.equal(got.length, 0, "조회가 비면 상한과 무관하게 비어야 한다");
  const got2 = selectVanishedCases([1, 2, 3, 4, 5], [item(9)], 2);
  assert.deepEqual(got2, [1, 2]);
});

// 같은 건이 두 번 들어와도 한 번만 집는다(조회 합치기에서 중복이 올 수 있다).
test("중복은 한 번만 집는다", () => {
  assert.deepEqual(selectVanishedCases([7, 7], [item(9)]), [7]);
});
