import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_PREVIOUS, calculateInstances } from "../lib/instanceCount.ts";
import type { InstanceInput, PreviousMonth } from "../lib/instanceCount.ts";

/**
 * 기대값은 전부 정기점검인스턴스계산.xlsx 에서 그대로 가져왔다.
 * 엑셀 수식을 코드로 옮긴 것이 맞는지 증명하는 것이 이 테스트의 목적이라,
 * 값을 직접 계산해서 적으면 안 된다 — 스프레드시트가 낸 답을 적어야 한다.
 */

// 시트 "월정기점검 인스턴스검사(7월)"
const JULY: InstanceInput = {
  bank: { dev: 320, prod: 464, dr: 415 },
  central: { dev: 83, prod: 134, dr: 99 },
  shared: { dev: 76, prod: 107, dr: 100 },
};
const JULY_PREV: PreviousMonth = {
  bankProd: 674, bankProdShared: 206, bankDev: 234,
  bankDevShared: 76, centralProd: 236, centralDev: 87,
};

test("7월 시트의 컨테이너 수를 그대로 낸다", () => {
  const r = calculateInstances(JULY, JULY_PREV);
  assert.deepEqual(r.rows.map((x) => x.container), [672, 207, 244, 76, 233, 83]);
  assert.equal(r.total.container, 1515);
});

test("7월 시트의 전월 대비 증감을 그대로 낸다", () => {
  const r = calculateInstances(JULY, JULY_PREV);
  assert.deepEqual(r.rows.map((x) => x.delta), [-2, 1, 10, 0, -3, -4]);
  assert.equal(r.total.delta, 2);
});

test("7월 시트의 실 운영 현황을 그대로 낸다", () => {
  const r = calculateInstances(JULY, JULY_PREV);
  assert.equal(r.actual.bank, 1058);
  assert.equal(r.actual.central, 457);
  assert.equal(r.actual.total, 1515);
});

test("공통 인스턴스는 은행이 올림, 중앙회가 내림으로 나눈다", () => {
  const r = calculateInstances(JULY, JULY_PREV);
  // 엑셀: N6 "은행: 104" / N7 "중앙회: 103"  (207 은 홀수)
  assert.match(r.rows[1]!.note, /은행 : 104/);
  assert.match(r.rows[1]!.note, /중앙회 : 103/);
  // 76 은 짝수라 38 / 38
  assert.match(r.rows[3]!.note, /은행 : 38/);
  assert.match(r.rows[3]!.note, /중앙회 : 38/);
});

test("클러스터·호스트 합계는 고정 인프라 값의 합이다", () => {
  const r = calculateInstances(JULY, JULY_PREV);
  assert.equal(r.total.cluster, 37);
  assert.equal(r.total.host, 176);
  assert.equal(r.rows[0]!.cluster, "24 (12/12)");
  assert.equal(r.rows[0]!.host, "120 (60/60)");
  assert.equal(r.rows[2]!.cluster, "4");
  assert.equal(r.rows[1]!.cluster, "", "공통 행에는 클러스터가 없다");
});

// 시트 "월정기점검 인스턴스검사(10월)" — 입력이 소수라 반올림 경로를 확인한다
const OCTOBER: InstanceInput = {
  bank: { dev: 428.1, prod: 463.1, dr: 392.2 },
  central: { dev: 122.5, prod: 128.5, dr: 92 },
  shared: { dev: 68, prod: 97, dr: 91 },
};

test("소수 입력도 엑셀과 같은 값을 낸다", () => {
  const r = calculateInstances(OCTOBER, EMPTY_PREVIOUS);
  const got = r.rows.map((x) => x.container);
  const want = [667.3, 188, 360.1, 68, 220.5, 122.5];
  for (const [i, w] of want.entries()) {
    assert.ok(Math.abs(got[i]! - w) < 1e-9, `${i}번째: ${got[i]} ≠ ${w}`);
  }
  assert.ok(Math.abs(r.total.container - 1626.4) < 1e-9);
  // 엑셀: 은행 94 / 중앙회 94 (188 은 짝수)
  assert.match(r.rows[1]!.note, /은행 : 94/);
  assert.match(r.rows[1]!.note, /중앙회 : 94/);
});

test("전월값이 없으면 증감은 이번 달 값 그대로다", () => {
  const r = calculateInstances(JULY, EMPTY_PREVIOUS);
  assert.deepEqual(r.rows.map((x) => x.delta), [672, 207, 244, 76, 233, 83]);
});

test("carryOver 를 다음 달 전월값으로 넣으면 증감이 0 이 된다", () => {
  const first = calculateInstances(JULY, EMPTY_PREVIOUS);
  const second = calculateInstances(JULY, first.carryOver);
  assert.deepEqual(second.rows.map((x) => x.delta), [0, 0, 0, 0, 0, 0]);
  assert.equal(second.total.delta, 0);
});

test("합계는 여섯 행의 합과 같다", () => {
  const r = calculateInstances(JULY, JULY_PREV);
  const sum = r.rows.reduce((acc, x) => acc + x.container, 0);
  assert.equal(r.total.container, sum);
  assert.equal(r.actual.total, sum, "실 운영 현황 합계도 같아야 한다");
});
