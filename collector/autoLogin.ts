/**
 * 자동 로그인.
 *
 * 기기가 신뢰 상태(1년짜리 쿠키)면 재로그인에 OTP를 요구하지 않는다.
 * 그래서 ID/비번만으로 무인 로그인이 가능하다.
 *
 * 다만 OTP를 요구받는 상황은 반드시 있다(신뢰 만료, 새 기기, 정책 변경).
 * 그때는 우회하지 않고 사람에게 넘긴다.
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { CREDENTIALS, NAV_TIMEOUT_MS, PORTAL_HOME, SESSION_FILE } from "../lib/config.ts";

export class OtpRequiredError extends Error {
  constructor() {
    super(
      "OTP 인증이 필요합니다. 자동 로그인으로는 진행할 수 없습니다.\n" +
        "  'npm run login' 을 직접 실행해 브라우저에서 OTP를 입력하세요.",
    );
    this.name = "OtpRequiredError";
  }
}

export class CredentialsMissingError extends Error {
  constructor() {
    super(
      "자동 로그인 계정이 설정되지 않았습니다.\n" +
        "  .env 에 SR_USERNAME / SR_PASSWORD 를 넣거나 'npm run login' 을 실행하세요.",
    );
    this.name = "CredentialsMissingError";
  }
}

const SEL = {
  username: "#usernameInput, input[name='userName']",
  rememberMe: "#rememberMe",
  password: "input[type='password']",
  submit: "button[type='submit']",
} as const;

/** OTP 화면인지 판정. 화면 문구와 입력 필드를 함께 본다. */
async function looksLikeOtpScreen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const text = document.body?.innerText?.toLowerCase() ?? "";
    const mentionsOtp =
      text.includes("otp") ||
      text.includes("verification code") ||
      text.includes("one-time");
    const hasCodeInput = Boolean(
      document.querySelector(
        "input[name*='otp' i], input[id*='otp' i], input[autocomplete='one-time-code']",
      ),
    );
    return mentionsOtp || hasCodeInput;
  });
}

/** 포털로 돌아왔는지 = 로그인 성공. */
function isSignedIn(page: Page): boolean {
  return page.url().includes("wolkenservicedesk.com") && !page.url().includes("/login-sso");
}

/**
 * 로그인 화면에서 ID/비번을 채워 넣는다.
 * 성공하면 true, OTP를 요구받으면 OtpRequiredError.
 */
export async function performCredentialLogin(page: Page): Promise<void> {
  if (CREDENTIALS === null) throw new CredentialsMissingError();

  await page.goto(PORTAL_HOME, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });

  // 이미 세션이 살아 있으면 로그인 화면이 뜨지 않는다.
  await page.waitForTimeout(4000);
  if (isSignedIn(page)) return;

  await page.waitForURL(/access\.broadcom\.com/, { timeout: NAV_TIMEOUT_MS });
  await page.waitForSelector(SEL.username, { timeout: NAV_TIMEOUT_MS });

  await page.fill(SEL.username, CREDENTIALS.username);
  // 기기 신뢰를 유지해야 다음 로그인에서 OTP를 다시 묻지 않는다.
  const remember = page.locator(SEL.rememberMe);
  if ((await remember.count()) > 0 && !(await remember.isChecked())) {
    await remember.check().catch(() => undefined);
  }
  await page.click(SEL.submit);

  await page.waitForSelector(SEL.password, { timeout: NAV_TIMEOUT_MS });
  await page.fill(SEL.password, CREDENTIALS.password);
  await page.click(SEL.submit);

  // 포털 복귀 또는 OTP 화면 중 먼저 오는 쪽을 기다린다.
  const deadline = Date.now() + NAV_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (isSignedIn(page)) return;
    if (await looksLikeOtpScreen(page)) throw new OtpRequiredError();
    await page.waitForTimeout(1500);
  }
  throw new Error("로그인 후 포털로 돌아오지 못했습니다 (타임아웃).");
}

/** 로그인 결과를 세션 파일로 저장한다. */
export async function saveSession(
  context: BrowserContext,
  sessionFile = SESSION_FILE,
): Promise<string> {
  const path = resolve(sessionFile);
  mkdirSync(dirname(path), { recursive: true });
  await context.storageState({ path });
  return path;
}
