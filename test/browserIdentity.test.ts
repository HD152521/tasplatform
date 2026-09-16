/**
 * 기기 신뢰 쿠키 추출 규칙.
 *
 * 이게 틀리면 로그인마다 OTP 를 다시 묻거나(신뢰 쿠키 누락),
 * 로그인 위젯이 무한 대기에 빠진다(만료된 세션 쿠키 혼입).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractDeviceCookies,
  extractDeviceOrigins,
  isDeviceTrustCookie,
  deviceTrustAvailable,
  saveDeviceState,
  type StorageState,
} from "../lib/browserIdentity.ts";

const HOUR = 3600 * 1000;
const now = Date.UTC(2026, 8, 9, 12, 0, 0);
/** Playwright 는 만료를 초 단위로 저장한다. */
const secondsFromNow = (ms: number) => (now + ms) / 1000;

function state(
  cookies: Array<Record<string, unknown>>,
  origins: StorageState["origins"] = [{ origin: "https://x", localStorage: [{ name: "junk", value: "1" }] }],
): StorageState {
  return { cookies: cookies as StorageState["cookies"], origins };
}

const IDP = "https://access.broadcom.com";

test("기기 신뢰 쿠키를 이름으로 알아본다", () => {
  assert.equal(isDeviceTrustCookie("_iat1"), true);
  assert.equal(isDeviceTrustCookie("__Secure-ob-bj7qu"), true);
  assert.equal(isDeviceTrustCookie("sspsession"), false);
});

test("사용자를 기억시키는 쿠키는 신뢰 표식으로 보지 않는다", () => {
  // 이것들이 섞이면 위젯이 아이디 단계를 건너뛰어 로그인 흐름과 어긋난다.
  assert.equal(isDeviceTrustCookie("__Secure-ssp-username"), false);
  assert.equal(isDeviceTrustCookie("__Secure-rbu"), false);
});

test("SSO 세션 쿠키는 반드시 제외한다", () => {
  const picked = extractDeviceCookies(
    state([
      { name: "sspsession", domain: ".access.broadcom.com", expires: secondsFromNow(12 * HOUR) },
      { name: "_iat1", domain: "access.broadcom.com", expires: secondsFromNow(365 * 24 * HOUR) },
    ]),
    now,
  );
  assert.deepEqual(picked.map((c) => c.name), ["_iat1"]);
});

test("만료된 신뢰 쿠키는 버린다", () => {
  const picked = extractDeviceCookies(
    state([{ name: "_iat1", domain: "access.broadcom.com", expires: secondsFromNow(-HOUR) }]),
    now,
  );
  assert.deepEqual(picked, []);
});

test("세션 쿠키(만료 없음)는 살아 있는 것으로 본다", () => {
  const picked = extractDeviceCookies(
    state([{ name: "__Secure-ob-x", domain: "access.broadcom.com", expires: -1 }]),
    now,
  );
  assert.deepEqual(picked.map((c) => c.name), ["__Secure-ob-x"]);
});

test("쿠키가 없는 상태도 견딘다", () => {
  assert.deepEqual(extractDeviceCookies({}, now), []);
  assert.deepEqual(extractDeviceCookies({ cookies: [] }, now), []);
});

test("골라낸 게 없으면 파일을 쓰지 않는다 (기존 파일 보존)", () => {
  const file = join(mkdtempSync(join(tmpdir(), "device-")), "device.json");
  assert.equal(saveDeviceState(state([{ name: "sspsession", domain: "x", expires: -1 }]), file), false);
  assert.equal(deviceTrustAvailable(file), false);
});

test("신뢰 쿠키만 저장하고 origins 는 버린다", () => {
  const file = join(mkdtempSync(join(tmpdir(), "device-")), "device.json");
  const saved = saveDeviceState(
    state([
      { name: "_iat1", domain: "access.broadcom.com", expires: secondsFromNow(365 * 24 * HOUR) },
      { name: "sspsession", domain: ".access.broadcom.com", expires: secondsFromNow(HOUR) },
    ]),
    file,
  );
  assert.equal(saved, true);
  assert.equal(deviceTrustAvailable(file), true);

  const written = JSON.parse(readFileSync(file, "utf8")) as StorageState;
  assert.deepEqual(written.cookies?.map((c) => c.name), ["_iat1"]);
  // IdP origin 의 기기 표식만 담는다. 관계없는 origin 은 버린다.
  assert.deepEqual(written.origins, []);
});

test("파일이 없으면 신뢰 없음으로 본다", () => {
  assert.equal(deviceTrustAvailable(join(tmpdir(), "no-such-device-file.json")), false);
});

test("IdP 의 기기 표식 localStorage 만 골라낸다", () => {
  const picked = extractDeviceOrigins(
    state([], [
      { origin: IDP, localStorage: [
        { name: "_ia01", value: "abc" },
        { name: "_ia01_timestamp_", value: "1:abc" },
        { name: "default.ssp-ah_dfp", value: "fp" },
        { name: "관계없는키", value: "x" },
      ] },
      { origin: "https://other.example", localStorage: [{ name: "_ia01", value: "z" }] },
    ]),
  );
  assert.equal(picked.length, 1);
  const only = picked[0];
  assert.ok(only !== undefined);
  assert.equal(only.origin, IDP);
  assert.deepEqual(only.localStorage?.map((i) => i.name), [
    "_ia01",
    "_ia01_timestamp_",
    "default.ssp-ah_dfp",
  ]);
});

test("IdP origin 이 없으면 빈 배열", () => {
  assert.deepEqual(extractDeviceOrigins(state([], [{ origin: "https://other", localStorage: [] }])), []);
  assert.deepEqual(extractDeviceOrigins({}), []);
});

test("쿠키가 없어도 기기 표식만으로 저장한다", () => {
  const file = join(mkdtempSync(join(tmpdir(), "device-")), "device.json");
  const saved = saveDeviceState(
    state([], [{ origin: IDP, localStorage: [{ name: "_ia01", value: "abc" }] }]),
    file,
  );
  assert.equal(saved, true);
  assert.equal(deviceTrustAvailable(file), true);
});
