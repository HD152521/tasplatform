/**
 * 첨부 처리용 세션 상태 — 쿠키만 남기고 origins 를 버리는 규칙.
 *
 * 이 규칙이 틀리면 **첨부가 전부 실패한다.** 컨텍스트가 세션 없이 만들어져 supportftp
 * 가 로그인 화면을 돌려주고, 사람은 "다시 로그인하세요" 만 본다. 수집기를 실제로
 * 돌려 보기 전에 여기서 잡는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cookiesOnlyState } from "../lib/attachSessionState.ts";

/** 실제 세션 파일과 같은 모양. origin 이 둘이고 각각 localStorage 를 들고 있다. */
const REAL_SHAPE = JSON.stringify({
  cookies: [
    { name: "CrushAuth", value: "1234567890abcd", domain: "supportftp.broadcom.com" },
    { name: "sspsession", value: "x", domain: ".broadcom.com" },
  ],
  origins: [
    { origin: "https://broadcomcms-software.wolkenservicedesk.com", localStorage: [{ name: "a", value: "1" }] },
    { origin: "https://access.broadcom.com", localStorage: [{ name: "_ia01", value: "2" }] },
  ],
});

test("쿠키는 그대로 남고 origins 는 비워진다", () => {
  const state = cookiesOnlyState(REAL_SHAPE);
  assert.ok(state !== null);
  assert.equal(state.cookies.length, 2, "쿠키를 하나도 잃으면 안 된다");
  assert.deepEqual(state.origins, [], "origins 는 비어야 한다 — 이게 11.6초를 줄인다");
});

/*
 * 쿠키 안을 들여다보지 않는다. CrushAuth 가 있는지 여기서 판정하면, 세션이 아직
 * supportftp 에 묶이지 않은 정상 상태(enterCase 전)를 실패로 오판한다.
 */
test("쿠키 내용은 손대지 않고 그대로 넘긴다", () => {
  const state = cookiesOnlyState(REAL_SHAPE);
  assert.ok(state !== null);
  assert.deepEqual(state.cookies, JSON.parse(REAL_SHAPE).cookies);
});

/*
 * 모르는 모양이면 **null** 이다. 부르는 쪽이 세션 파일 경로를 그대로 Playwright 에
 * 넘기도록 해야 한다 — 빈 쿠키 목록을 돌려주면 "세션이 없다" 는 엉뚱한 실패가 되고
 * 사람은 로그인을 의심한다. 모르면 손대지 않는 편이 낫다.
 */
test("읽을 수 없거나 쿠키가 없으면 null 이다", () => {
  assert.equal(cookiesOnlyState(""), null, "빈 문자열");
  assert.equal(cookiesOnlyState("{"), null, "깨진 JSON");
  assert.equal(cookiesOnlyState("null"), null, "null");
  assert.equal(cookiesOnlyState('"문자열"'), null, "객체가 아님");
  assert.equal(cookiesOnlyState("[]"), null, "배열");
  assert.equal(cookiesOnlyState("{}"), null, "cookies 없음");
  assert.equal(cookiesOnlyState('{"cookies":[]}'), null, "쿠키가 비어 있음");
  assert.equal(cookiesOnlyState('{"cookies":"x"}'), null, "cookies 가 배열이 아님");
});

// origins 가 애초에 없던 세션도 그대로 동작해야 한다(로그인 직후 등).
test("origins 가 없는 세션도 쿠키만 돌려준다", () => {
  const state = cookiesOnlyState('{"cookies":[{"name":"a","value":"1"}]}');
  assert.ok(state !== null);
  assert.equal(state.cookies.length, 1);
  assert.deepEqual(state.origins, []);
});
