import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_PREVIOUS, calculateInstances, roundCount } from "../lib/instanceCount.ts";
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

test("소수 입력은 아홉 칸을 반올림한 뒤 계산한다", () => {
  const r = calculateInstances(OCTOBER, EMPTY_PREVIOUS);
  // 엑셀의 원래 값은 [667.3, 188, 360.1, 68, 220.5, 122.5] / 합계 1626.4 였다.
  // 보고서에는 정수만 들어가므로 입력 아홉 칸을 먼저 반올림한다.
  //   은행 428.1→428 / 463.1→463 / 392.2→392,  중앙회 122.5→123 / 128.5→129 / 92
  assert.deepEqual(r.rows.map((x) => x.container), [667, 188, 360, 68, 221, 123]);
  // 1627 이다. 총합(1626.4)을 따로 반올림한 1626 이 아니다 — 그러면 행 합과 어긋난다.
  assert.equal(r.total.container, 1627);
  assert.equal(r.rows.reduce((acc, x) => acc + x.container, 0), r.total.container);
  // 엑셀: 은행 94 / 중앙회 94 (188 은 짝수)
  assert.match(r.rows[1]!.note, /은행 : 94/);
  assert.match(r.rows[1]!.note, /중앙회 : 94/);
});

test("소수 입력에서도 증감·실 운영 현황·carryOver 가 전부 정수다", () => {
  const r = calculateInstances(OCTOBER, EMPTY_PREVIOUS);
  const numbers = [
    ...r.rows.map((x) => x.delta),
    r.total.delta,
    r.actual.bank, r.actual.central, r.actual.total,
    ...Object.values(r.carryOver),
  ];
  for (const n of numbers) {
    assert.ok(Number.isInteger(n), `정수가 아니다: ${n}`);
  }
});

test("예전에 저장된 소수 전월값과 섞여도 증감이 정수로 나온다", () => {
  // instance_counts 는 REAL 컬럼이라 이 고침 전에 저장된 달에는 소수가 남아 있다.
  const previous: PreviousMonth = {
    bankProd: 666.5, bankProdShared: 188, bankDev: 360.4,
    bankDevShared: 68, centralProd: 220.5, centralDev: 122.5,
  };
  const r = calculateInstances(OCTOBER, previous);
  // 전월값도 같은 규칙으로 반올림한다: 666.5→667, 360.4→360, 220.5→221, 122.5→123
  assert.deepEqual(r.rows.map((x) => x.delta), [0, 0, 0, 0, 0, 0]);
  assert.equal(r.total.delta, 0);
});

/* ------------------------------------------------------------------ *
 * roundCount — 경계값
 * ------------------------------------------------------------------ */

test("0.5 는 올린다 (은행가 반올림이 아니다)", () => {
  assert.equal(roundCount(133.4), 133);
  assert.equal(roundCount(136.5), 137);
  assert.equal(roundCount(133), 133);
  // 파이썬 round() 는 이 셋을 각각 0, 2, 4 로 만든다. 그래서 파이썬에 맡기지 않는다.
  assert.equal(roundCount(0.5), 1);
  assert.equal(roundCount(2.5), 3);
  assert.equal(roundCount(4.5), 5);
});

test("0.4 는 내리고 0.6 은 올린다", () => {
  assert.equal(roundCount(0.4), 0);
  assert.equal(roundCount(0.6), 1);
  assert.equal(roundCount(133.49), 133);
  assert.equal(roundCount(133.51), 134);
});

test("0 은 0 이다", () => {
  assert.equal(roundCount(0), 0);
  assert.ok(!Object.is(roundCount(0), -0), "-0 이 나오면 표에 '-0' 이 찍힌다");
});

test("음수는 0 으로 막는다", () => {
  // 인스턴스가 음수인 달은 없다. Math.round(-0.5) 가 -0 이라 그대로 두면 표가 이상해진다.
  assert.equal(roundCount(-0.5), 0);
  assert.ok(!Object.is(roundCount(-0.5), -0));
  assert.equal(roundCount(-3.2), 0);
  assert.equal(roundCount(-100), 0);
});

test("숫자가 아니면 0 이다 — 표에 NaN 을 찍지 않는다", () => {
  assert.equal(roundCount(Number.NaN), 0);
  assert.equal(roundCount(Number.POSITIVE_INFINITY), 0);
  assert.equal(roundCount(Number.NEGATIVE_INFINITY), 0);
  assert.equal(roundCount("133.6"), 0, "문자열은 경계에서 Number() 로 바꿔서 넣어야 한다");
  assert.equal(roundCount(""), 0);
  assert.equal(roundCount(null), 0);
  assert.equal(roundCount(undefined), 0);
  assert.equal(roundCount({}), 0);
});

test("NaN 이 섞여 들어와도 표에 NaN 이 남지 않는다", () => {
  const broken = {
    bank: { dev: Number.NaN, prod: 463.1, dr: 392.2 },
    central: { dev: 122.5, prod: 128.5, dr: 92 },
    shared: { dev: 68, prod: 97, dr: 91 },
  } as InstanceInput;
  const r = calculateInstances(broken, EMPTY_PREVIOUS);
  for (const row of r.rows) {
    assert.ok(Number.isInteger(row.container), `NaN 이 남았다: ${row.container}`);
  }
  // 은행 개발 = 0 − 68 → 음수지만, 그건 "덜 넣었다" 는 뜻이라 그대로 보여준다.
  assert.equal(r.rows[2]!.container, -68);
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
