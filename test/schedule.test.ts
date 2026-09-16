/**
 * worker 스케줄 순수 함수 테스트.
 *
 * 밀폐(hermetic): 시간·환경·IO 를 만지지 않는 순수 함수만 검증한다.
 * 실제 spawn·루프·시그널은 부작용이라 여기서 다루지 않는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHours, isWithinHours, resolveDurationMs } from "../collector/schedule.ts";

/** 특정 시(hour)의 Date 를 만든다(로컬시 기준 — isWithinHours 는 getHours 를 쓴다). */
function at(hour: number): Date {
  return new Date(2026, 8, 16, hour, 30, 0);
}

test("parseHours: 정상 스펙을 파싱한다", () => {
  assert.deepEqual(parseHours("8-20"), { start: 8, end: 20 });
  assert.deepEqual(parseHours("0-24"), { start: 0, end: 24 });
  assert.deepEqual(parseHours(" 9 - 18 "), { start: 9, end: 18 }, "공백은 허용");
  assert.deepEqual(parseHours("20-6"), { start: 20, end: 6 }, "야간 랩어라운드도 파싱");
});

test("parseHours: 경계값", () => {
  assert.deepEqual(parseHours("0-0"), { start: 0, end: 0 });
  assert.deepEqual(parseHours("23-24"), { start: 23, end: 24 });
});

test("parseHours: 잘못된 형식·범위는 null", () => {
  for (const bad of [
    "",
    "8",
    "8-",
    "-20",
    "8:00-20:00",
    "eight-twenty",
    "24-8", // start 는 최대 23
    "8-25", // end 는 최대 24
    "-1-5",
    "8_20",
    "8-20-22",
  ]) {
    assert.equal(parseHours(bad), null, `"${bad}" 은 null 이어야`);
  }
});

test("isWithinHours: 미설정/빈문자열이면 항상 true", () => {
  assert.equal(isWithinHours(at(3), ""), true);
  assert.equal(isWithinHours(at(3), "   "), true);
});

test("isWithinHours: 잘못된 스펙은 fail-open(true)", () => {
  assert.equal(isWithinHours(at(3), "garbage"), true);
  assert.equal(isWithinHours(at(3), "8-25"), true);
});

test("isWithinHours: 주간 구간 '8-20' — 경계 규칙 start ≤ hour < end", () => {
  assert.equal(isWithinHours(at(7), "8-20"), false, "7시는 밖");
  assert.equal(isWithinHours(at(8), "8-20"), true, "시작 시(8)는 포함");
  assert.equal(isWithinHours(at(19), "8-20"), true, "19시는 안");
  assert.equal(isWithinHours(at(20), "8-20"), false, "종료 시(20)는 제외");
  assert.equal(isWithinHours(at(23), "8-20"), false, "23시는 밖");
});

test("isWithinHours: 야간 랩어라운드 '20-6'", () => {
  assert.equal(isWithinHours(at(20), "20-6"), true, "시작 시(20) 포함");
  assert.equal(isWithinHours(at(23), "20-6"), true);
  assert.equal(isWithinHours(at(0), "20-6"), true, "자정 넘어도 안");
  assert.equal(isWithinHours(at(5), "20-6"), true);
  assert.equal(isWithinHours(at(6), "20-6"), false, "종료 시(6) 제외");
  assert.equal(isWithinHours(at(12), "20-6"), false, "낮은 밖");
});

test("isWithinHours: start === end 는 항상 true(모호 → 안전)", () => {
  assert.equal(isWithinHours(at(0), "8-8"), true);
  assert.equal(isWithinHours(at(15), "8-8"), true);
});

// --- resolveDurationMs: ms 설정 검증(하한/상한 대칭) ---

const FALLBACK = 900_000;
const MIN = 1_000;
const MAX = 86_400_000;

test("resolveDurationMs: 미설정/빈문자열이면 fallback(경고 없음)", () => {
  for (const raw of [undefined, "", "   "]) {
    const r = resolveDurationMs(raw, FALLBACK, MIN, MAX);
    assert.equal(r.value, FALLBACK);
    assert.equal(r.warning, null);
  }
});

test("resolveDurationMs: 정상 범위 값은 정수화해 채택", () => {
  assert.equal(resolveDurationMs("2000", FALLBACK, MIN, MAX).value, 2000);
  assert.equal(resolveDurationMs("2000.9", FALLBACK, MIN, MAX).value, 2000, "소수점 버림");
  assert.equal(resolveDurationMs("2000", FALLBACK, MIN, MAX).warning, null);
});

test("resolveDurationMs: 경계 포함(min·max 는 유효)", () => {
  assert.equal(resolveDurationMs(String(MIN), FALLBACK, MIN, MAX).value, MIN);
  assert.equal(resolveDurationMs(String(MAX), FALLBACK, MIN, MAX).value, MAX);
});

test("resolveDurationMs: 하한 미만은 fallback + 경고", () => {
  const r = resolveDurationMs(String(MIN - 1), FALLBACK, MIN, MAX);
  assert.equal(r.value, FALLBACK);
  assert.ok(r.warning !== null, "경고가 있어야");
});

test("resolveDurationMs: 상한 초과는 fallback + 경고(setTimeout 클램프 방지)", () => {
  const r = resolveDurationMs(String(MAX + 1), FALLBACK, MIN, MAX);
  assert.equal(r.value, FALLBACK);
  assert.ok(r.warning !== null, "경고가 있어야");
  // 2^31-1 을 넘는 값도 반드시 걸러진다.
  const huge = resolveDurationMs("2147483648", FALLBACK, MIN, MAX);
  assert.equal(huge.value, FALLBACK);
  assert.ok(huge.warning !== null);
});

test("resolveDurationMs: 숫자가 아니면 fallback + 경고", () => {
  for (const bad of ["abc", "10s", "NaN", "1e999"]) {
    const r = resolveDurationMs(bad, FALLBACK, MIN, MAX);
    assert.equal(r.value, FALLBACK, `"${bad}" 은 fallback`);
    assert.ok(r.warning !== null);
  }
});
