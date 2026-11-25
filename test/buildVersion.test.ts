/**
 * 돌고 있는 빌드가 어느 커밋인가.
 *
 * 이 값이 없어서 "고쳤는데 아직도 안 된다" 가 **배포 누락인지 코드 문제인지** 가리는
 * 데 한참 걸렸다. 그 진단에 쓰는 값이므로, 읽다 실패해서 헬스체크를 500 으로 만들면
 * 고치려던 문제를 키운다 — 어떤 입력에도 던지지 않아야 한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { UNKNOWN_VERSION, parseVersion } from "../lib/buildVersion.ts";

test("커밋과 빌드 시각을 읽는다", () => {
  const v = parseVersion("80ca58a 2026-11-25T01:30:00Z\n");
  assert.equal(v.commit, "80ca58a");
  assert.equal(v.builtAt, "2026-11-25T01:30:00Z");
});

test("커밋만 있어도 된다", () => {
  assert.deepEqual(parseVersion("80ca58a"), { commit: "80ca58a", builtAt: "" });
});

test("빈 파일·공백은 unknown 이다 — 그럴듯한 값을 만들지 않는다", () => {
  // "unknown" 이 보이는 것 자체가 "CI 를 안 거친 빌드" 라는 정보다.
  for (const raw of ["", "\n", "   \n  \n"]) {
    assert.deepEqual(parseVersion(raw), UNKNOWN_VERSION, JSON.stringify(raw));
  }
});

test("앞의 빈 줄을 건너뛰고 첫 내용 줄을 읽는다", () => {
  assert.equal(parseVersion("\n\n  80ca58a 2026-11-25T01:30:00Z  \n").commit, "80ca58a");
});

test("칸이 여러 개여도 앞 둘만 쓴다", () => {
  const v = parseVersion("80ca58a 2026-11-25T01:30:00Z main runner-3");
  assert.equal(v.commit, "80ca58a");
  assert.equal(v.builtAt, "2026-11-25T01:30:00Z");
});
