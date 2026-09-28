/**
 * 세션 상태 판정.
 *
 * 이 판정이 틀리면 두 가지가 같이 무너진다 — 화면의 "세션은 언제까지 유효합니다" 표시와,
 * hydrate 가 "낡은 파일을 DB 것으로 바꿀지" 결정하는 기준. 그래서 파일이 아니라 문자열을
 * 받는 형태로 떼어 놓고 여기서 직접 잰다.
 *
 * 실제 쿠키 값은 쓰지 않는다. 판정에 쓰이는 것은 이름과 만료뿐이다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionStatusFromJson } from "../lib/sessionFile.ts";

const HOUR_MS = 3_600_000;

interface FakeCookie {
  name: string;
  domain?: string;
  /** 초 단위(Playwright 형식). 생략하면 세션 쿠키. */
  expires?: number;
}

/** 초 단위 만료로 바꾼다 — Playwright 가 그렇게 저장한다. */
function inHours(hours: number): number {
  return (Date.now() + hours * HOUR_MS) / 1000;
}

function sessionJson(...cookies: FakeCookie[]): string {
  return JSON.stringify({
    cookies: cookies.map((c) => ({ domain: "access.broadcom.com", ...c })),
  });
}

test("살아 있는 SSO 세션은 유효로 읽는다", () => {
  const status = sessionStatusFromJson(sessionJson({ name: "sspsession", expires: inHours(6) }));
  assert.equal(status.expired, false);
  assert.ok(status.expiresAt !== null);
});

test("지난 SSO 세션은 만료로 읽는다", () => {
  const status = sessionStatusFromJson(sessionJson({ name: "sspsession", expires: inHours(-1) }));
  assert.equal(status.expired, true);
});

// SSO 쿠키가 없으면 쓰기가 안 된다. "모른다" 가 아니라 만료와 같이 다뤄야 한다 —
// 안 그러면 hydrate 가 쓸 수 없는 파일을 붙잡고 DB 의 멀쩡한 세션을 안 가져온다.
test("sspsession 이 없으면 만료로 본다", () => {
  const status = sessionStatusFromJson(sessionJson({ name: "_iat1", expires: inHours(8760) }));
  assert.equal(status.expired, true);
  assert.equal(status.expiresAt, null);
});

test("깨진 JSON 은 만료로 본다", () => {
  assert.equal(sessionStatusFromJson("not json at all").expired, true);
  assert.equal(sessionStatusFromJson("").expired, true);
});

test("쿠키 목록이 없어도 터지지 않는다", () => {
  assert.equal(sessionStatusFromJson("{}").expired, true);
});

test("기기 신뢰 표식은 SSO 세션과 따로 본다", () => {
  // 세션은 죽었지만 기기 신뢰는 살아 있는 상태 — 재로그인 때 OTP 를 생략할 수 있다.
  const status = sessionStatusFromJson(sessionJson(
    { name: "sspsession", expires: inHours(-100) },
    { name: "_iat1", expires: inHours(8760) },
  ));
  assert.equal(status.expired, true);
  assert.equal(status.deviceTrusted, true);
});

test("기기 신뢰 표식이 없으면 false", () => {
  const status = sessionStatusFromJson(sessionJson({ name: "sspsession", expires: inHours(6) }));
  assert.equal(status.deviceTrusted, false);
});
