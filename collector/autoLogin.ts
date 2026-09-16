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
import {
  API_HEADERS,
  API_ORIGIN,
  CREDENTIALS,
  DEFAULT_TEAM_ID,
  NAV_TIMEOUT_MS,
  PORTAL_HOME,
  deviceFileForTeam,
  sessionFileForTeam,
} from "../lib/config.ts";
import { saveDeviceState, type StorageState } from "../lib/browserIdentity.ts";

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

/**
 * OTP 화면인지 판정. 화면 문구와 입력 필드를 함께 본다.
 *
 * 방식 선택 화면(factorselection)도 포함한다. 실측상 비밀번호 통과 후 여기서
 * 멈추는데, 이걸 빼면 코드 입력칸이 없다는 이유로 못 알아보고 타임아웃까지
 * 헛기다린 뒤 엉뚱한 사유로 실패한다.
 */
async function looksLikeOtpScreen(page: Page): Promise<boolean> {
  if (page.url().includes("factorselection")) return true;
  return page.evaluate(() => {
    const text = document.body?.innerText?.toLowerCase() ?? "";
    const mentionsOtp =
      text.includes("otp") ||
      text.includes("verification code") ||
      text.includes("one-time") ||
      text.includes("select a way to sign in");
    const hasCodeInput = Boolean(
      document.querySelector(
        "input[name*='otp' i], input[id*='otp' i], input[autocomplete='one-time-code']",
      ),
    );
    return mentionsOtp || hasCodeInput;
  });
}

/**
 * 세션이 실제로 발급됐는지.
 *
 * URL 로 판정하면 이르다. 로그인 직후 착지하는 `/auth-sso` 는 아직 SPA 가
 * id_token 을 넘기기 전이라 Wolken 세션 쿠키가 없다. 그 상태로 저장하면
 * 쿠키 한 개짜리 빈 세션 파일이 남는다(실측). 발급 여부는 API 가 정답이다.
 */
async function sessionEstablished(page: Page): Promise<boolean> {
  const response = await page
    .context()
    .request.get(`${API_ORIGIN}/account_service/issessionvalid`, { headers: API_HEADERS })
    .catch(() => null);
  return response?.status() === 200;
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
  if (await sessionEstablished(page)) return;

  await page.waitForURL(/access\.broadcom\.com/, { timeout: NAV_TIMEOUT_MS });

  // 기기를 기억하고 있으면 아이디 단계를 건너뛰고 바로 비밀번호를 묻는다.
  // 둘 중 먼저 나타나는 쪽을 기다렸다가 분기한다.
  await page.waitForSelector(`${SEL.username}, ${SEL.password}`, { timeout: NAV_TIMEOUT_MS });

  const username = page.locator(SEL.username).first();
  if ((await username.count()) > 0 && (await username.isVisible().catch(() => false))) {
    await username.fill(CREDENTIALS.username);
    // 기기 신뢰를 유지해야 다음 로그인에서 OTP를 다시 묻지 않는다.
    const remember = page.locator(SEL.rememberMe);
    if ((await remember.count()) > 0 && !(await remember.isChecked())) {
      await remember.check().catch(() => undefined);
    }
    await page.click(SEL.submit);
    await page.waitForSelector(SEL.password, { timeout: NAV_TIMEOUT_MS });
  }
  await page.fill(SEL.password, CREDENTIALS.password);
  await page.click(SEL.submit);

  // 포털 복귀 또는 OTP 화면 중 먼저 오는 쪽을 기다린다.
  // 세션 발급까지 기다린다. OTP 화면이 먼저 뜨면 우회하지 않고 사람에게 넘긴다.
  const deadline = Date.now() + NAV_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await sessionEstablished(page)) return;
    if (await looksLikeOtpScreen(page)) throw new OtpRequiredError();
    await page.waitForTimeout(1500);
  }
  throw new Error("로그인 후 세션이 발급되지 않았습니다 (타임아웃).");
}

/**
 * 로그인 결과를 세션 파일로 저장한다.
 * 기기 신뢰 쿠키는 따로 한 벌 더 남긴다 — 다음 로그인이 OTP 를 건너뛰려면 필요하다.
 * teamId 를 생략하면 기본 팀의 파일(기존 SESSION_FILE/DEVICE_FILE)에 저장한다.
 */
export async function saveSession(
  context: BrowserContext,
  teamId: string = DEFAULT_TEAM_ID,
): Promise<string> {
  const path = resolve(sessionFileForTeam(teamId));
  mkdirSync(dirname(path), { recursive: true });
  const state = await context.storageState({ path });
  saveDeviceState(state as StorageState, deviceFileForTeam(teamId));
  return path;
}
