import { test } from "node:test";
import assert from "node:assert/strict";
import { monthsBefore, parseWolkenDate, toEpochMs } from "../lib/dates.ts";

test("포털 날짜 형식을 파싱한다", () => {
  const d = parseWolkenDate("01-September-2026 23:54:12");
  assert.ok(d);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 1);
  assert.equal(d.getHours(), 23);
  assert.equal(d.getSeconds(), 12);
});

test("한 자리 일자도 파싱한다", () => {
  assert.ok(parseWolkenDate("5-March-2026 09:05:00"));
});

test("잘못된 값은 예외 대신 null 을 준다", () => {
  for (const bad of ["", "2026-09-01", "31-Foobar-2026 00:00:00", null, undefined]) {
    assert.equal(parseWolkenDate(bad as string), null);
  }
});

test("toEpochMs 는 비교 가능한 수를 준다", () => {
  const older = toEpochMs("01-June-2026 00:00:00");
  const newer = toEpochMs("01-September-2026 00:00:00");
  assert.ok(older !== null && newer !== null && older < newer);
});

test("monthsBefore 는 과거 시각을 준다", () => {
  const base = new Date(2026, 8, 2);
  assert.equal(monthsBefore(3, base).getMonth(), 5);
});
