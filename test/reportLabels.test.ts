/**
 * 보고서 월 표기.
 *
 * 이게 틀리면 **파일을 열어 봐도 눈치채기 어렵다.** 09월 보고서에 "2026.08.31 기준"
 * 과 "2026년 05월" 이 찍혀 나간 적이 있다. 달 경계·윤년·한 자리 달을 전부 잠근다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { asOfLabel, footerMonthLabel, monthLabel } from "../lib/reportLabels.ts";

test("표 머리의 달은 두 자리다", () => {
  assert.equal(monthLabel("2026-09"), "09월");
  assert.equal(monthLabel("2026-01"), "01월");
  assert.equal(monthLabel("2026-12"), "12월");
});

// 기준일은 그 달의 **마지막 날**이다. 30일·31일·2월을 각각 확인한다.
test("기준일은 보고월의 말일이다", () => {
  assert.equal(asOfLabel("2026-09"), "2026.09.30 기준");
  assert.equal(asOfLabel("2026-08"), "2026.08.31 기준");
  assert.equal(asOfLabel("2026-01"), "2026.01.31 기준");
  assert.equal(asOfLabel("2026-12"), "2026.12.31 기준");
});

// 2026년은 평년, 2028년은 윤년이다. Date(연, 월, 0) 이 이걸 알아서 처리한다.
test("2월은 평년 28일 · 윤년 29일", () => {
  assert.equal(asOfLabel("2026-02"), "2026.02.28 기준");
  assert.equal(asOfLabel("2028-02"), "2028.02.29 기준");
  // 100으로 나뉘지만 400으로는 안 나뉘는 해는 평년이다.
  assert.equal(asOfLabel("2100-02"), "2100.02.28 기준");
});

/*
 * 바닥글은 연·월만 만든다. 나머지 문장은 양식에 있고 파이썬이 이 앞부분만 바꾼다.
 * 달은 두 자리로 맞춘다 — 양식이 "2026년 05월" 이라 한 자리로 내면 자리수가 흔들린다.
 */
test("바닥글은 연과 두 자리 달만 만든다", () => {
  assert.equal(footerMonthLabel("2026-09"), "2026년 09월");
  assert.equal(footerMonthLabel("2026-05"), "2026년 05월");
  assert.equal(footerMonthLabel("2027-11"), "2027년 11월");
});

/*
 * 형식이 어긋나면 **던진다.** 조용히 넘기면 엉뚱한 달의 보고서가 고객에게 나간다.
 * 세 함수가 같은 검사를 쓰므로 한 번에 확인한다.
 */
test("형식이 잘못된 보고월은 거부한다", () => {
  const bad = ["2026-9", "26-09", "2026/09", "2026-09-30", "", "abcd-ef", "2026-00", "2026-13"];
  for (const month of bad) {
    for (const make of [monthLabel, asOfLabel, footerMonthLabel]) {
      assert.throws(() => make(month), RangeError, `거부해야 함: ${month}`);
    }
  }
});
