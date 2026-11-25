/**
 * 사이드바의 접힘 목록을 확정하는 자리.
 *
 * 여기서 터지면 **화면 하나가 아니라 모든 화면**이 "Application error" 가 된다 —
 * 사이드바는 layout 이 그리기 때문이다. 게다가 값이 브라우저에 남아 있어 지울 때까지
 * 계속 그렇고, 그 사람에게만 보인다("내 것만 안 된다").
 *
 * 접힘은 편의일 뿐이다. 잘못된 값 하나로 도구를 못 쓰게 만들 이유가 없다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { collapsedNames } from "../lib/navCollapse.ts";

test("문자열 배열은 그대로 쓴다", () => {
  assert.deepEqual(collapsedNames(["팀 설정", "참고 자료"]), ["팀 설정", "참고 자료"]);
});

test("배열이 아니면 빈 목록이다 — includes 가 터지지 않는다", () => {
  for (const bad of [null, undefined, 0, "팀 설정", true, { "팀 설정": true }]) {
    assert.deepEqual(collapsedNames(bad), [], JSON.stringify(bad) ?? "undefined");
  }
});

test("섞여 있으면 문자열만 남긴다", () => {
  assert.deepEqual(collapsedNames(["팀 설정", 3, null, "로그"]), ["팀 설정", "로그"]);
});
