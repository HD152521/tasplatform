/**
 * 브라우저 실행 방식 선택 규칙 (collector/launchPlan.ts).
 *
 * 이게 틀리면 두 가지로 조용히 깨진다.
 *  - 컨테이너에서 로컬 브라우저 경로를 타면 무인 재로그인이 "바이너리 없음"으로 실패한다.
 *  - 로컬에서 번들(@sparticuz) 경로를 타면 headed 창이 뜨지 않아 사람이 OTP 를 못 넣는다.
 *
 * 실제 브라우저는 절대 띄우지 않는다 — 순수 판정 함수만 검증한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enableSparticuzSystemLibs,
  isCloudFoundry,
  planBrowserLaunch,
  shouldUseBundledChromium,
} from "../collector/launchPlan.ts";

/** 테스트용 최소 env. 프로세스 env 를 건드리지 않으려 매번 새로 만든다. */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

test("SR_HEADLESS 가 켜짐이면 요청과 무관하게 번들·headless 로 간다", () => {
  // Arrange
  const e = env({ SR_HEADLESS: "1" });

  // Act
  const plan = planBrowserLaunch(false, e);

  // Assert
  assert.equal(plan.bundled, true);
  assert.equal(plan.headless, true);
});

test("SR_HEADLESS 꺼짐은 CF 안에서도 로컬 경로로 되돌린다(탈출구)", () => {
  // Arrange: CF 컨테이너지만 명시적으로 끔
  const e = env({ SR_HEADLESS: "0", VCAP_APPLICATION: "{\"name\":\"x\"}" });

  // Act
  const plan = planBrowserLaunch(true, e);

  // Assert
  assert.equal(plan.bundled, false);
  assert.equal(plan.headless, true); // 요청한 headless 는 그대로 존중
});

test("설정이 없으면 CF(VCAP_APPLICATION) 이면 번들로 간다", () => {
  const e = env({ VCAP_APPLICATION: "{\"application_id\":\"abc\"}" });
  const plan = planBrowserLaunch(false, e);
  assert.equal(plan.bundled, true);
  assert.equal(plan.headless, true); // 번들은 화면이 없으므로 항상 headless
});

test("로컬(설정 없음·CF 아님)은 요청한 headless 를 존중한다", () => {
  // headed 로그인
  const headed = planBrowserLaunch(false, env());
  assert.deepEqual(headed, { bundled: false, headless: false });

  // 헤드리스 수집
  const headless = planBrowserLaunch(true, env());
  assert.deepEqual(headless, { bundled: false, headless: true });
});

test("SR_HEADLESS 는 다양한 켜짐/꺼짐 표기를 받아들인다", () => {
  for (const on of ["1", "true", "TRUE", "yes", "on", " On "]) {
    assert.equal(shouldUseBundledChromium(env({ SR_HEADLESS: on })), true, `켜짐: ${on}`);
  }
  for (const off of ["0", "false", "No", "off"]) {
    // CF 아님 + 명시적 꺼짐 → 로컬
    assert.equal(shouldUseBundledChromium(env({ SR_HEADLESS: off })), false, `꺼짐: ${off}`);
  }
});

test("SR_HEADLESS 가 빈 문자열/알 수 없는 값이면 CF 판정으로 넘어간다", () => {
  // 빈 값 + CF → 번들
  assert.equal(shouldUseBundledChromium(env({ SR_HEADLESS: "  ", VCAP_APPLICATION: "{}x" })), true);
  // 알 수 없는 값 + CF 아님 → 로컬
  assert.equal(shouldUseBundledChromium(env({ SR_HEADLESS: "maybe" })), false);
});

test("isCloudFoundry 는 VCAP_APPLICATION 유무로만 판단한다", () => {
  assert.equal(isCloudFoundry(env({ VCAP_APPLICATION: "{\"a\":1}" })), true);
  assert.equal(isCloudFoundry(env({ VCAP_APPLICATION: "   " })), false); // 공백뿐이면 없음
  assert.equal(isCloudFoundry(env()), false);
});

test("enableSparticuzSystemLibs: 미설정 env 에 AL2023 표식을 심는다", () => {
  // Arrange
  const e = env();

  // Act
  enableSparticuzSystemLibs(e);

  // Assert: "20.x" 가 들어가야 isRunningInAmazonLinux2023 이 참이 되어 라이브러리를 푼다.
  assert.match(String(e.AWS_LAMBDA_JS_RUNTIME), /20\.x/);
});

test("enableSparticuzSystemLibs: 이미 AL2023(20.x/22.x)면 덮어쓰지 않는다", () => {
  const a = env({ AWS_LAMBDA_JS_RUNTIME: "nodejs22.x" });
  enableSparticuzSystemLibs(a);
  assert.equal(a.AWS_LAMBDA_JS_RUNTIME, "nodejs22.x"); // 그대로

  const b = env({ AWS_EXECUTION_ENV: "AWS_Lambda_nodejs20.x" });
  enableSparticuzSystemLibs(b);
  assert.equal(b.AWS_LAMBDA_JS_RUNTIME, undefined); // 실행환경으로 이미 참이라 손대지 않음
});
