/**
 * worker.ensureContainerHeadless 동작.
 *
 * 컨테이너(CF)에서 무인 재로그인이 번들 Chromium 경로를 확실히 타게 하려고, CF 이면서
 * SR_HEADLESS 가 비어 있을 때만 SR_HEADLESS=1 을 켠다. 이미 설정돼 있으면(켬·끔 모두)
 * 존중하고, 로컬(비-CF)에서는 절대 건드리지 않는다 — 안 그러면 로컬 `npm run worker` 가
 * headed 대신 번들 경로로 새서 사람이 OTP 를 못 넣는다.
 *
 * process.env 를 직접 바꾸는 함수라 매 테스트마다 관련 키를 저장/복원한다.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ensureContainerHeadless } from "../collector/worker.ts";

const KEYS = ["SR_HEADLESS", "VCAP_APPLICATION"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  // 테스트가 각자 원하는 값만 세팅하도록 우선 비운다.
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

test("CF 이고 SR_HEADLESS 가 없으면 1 로 켠다", () => {
  // Arrange
  process.env.VCAP_APPLICATION = '{"application_id":"abc"}';

  // Act
  ensureContainerHeadless();

  // Assert
  assert.equal(process.env.SR_HEADLESS, "1");
});

test("CF 이고 SR_HEADLESS 가 공백뿐이면 1 로 켠다(미설정 취급)", () => {
  process.env.VCAP_APPLICATION = "{}x";
  process.env.SR_HEADLESS = "  ";
  ensureContainerHeadless();
  assert.equal(process.env.SR_HEADLESS, "1");
});

test("CF 라도 SR_HEADLESS 가 이미 꺼짐이면 건드리지 않는다(탈출구 존중)", () => {
  process.env.VCAP_APPLICATION = '{"application_id":"abc"}';
  process.env.SR_HEADLESS = "0";
  ensureContainerHeadless();
  assert.equal(process.env.SR_HEADLESS, "0");
});

test("CF 이고 SR_HEADLESS 가 이미 켜짐이면 그대로 둔다", () => {
  process.env.VCAP_APPLICATION = '{"application_id":"abc"}';
  process.env.SR_HEADLESS = "1";
  ensureContainerHeadless();
  assert.equal(process.env.SR_HEADLESS, "1");
});

test("로컬(비-CF)에서는 SR_HEADLESS 를 설정하지 않는다", () => {
  // VCAP_APPLICATION 없음
  ensureContainerHeadless();
  assert.equal(process.env.SR_HEADLESS, undefined);
});

test("로컬(비-CF)에서는 이미 있는 SR_HEADLESS 도 건드리지 않는다", () => {
  process.env.SR_HEADLESS = "0";
  ensureContainerHeadless();
  assert.equal(process.env.SR_HEADLESS, "0");
});
