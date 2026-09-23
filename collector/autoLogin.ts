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
import { LOGIN_SEL, describeLoginPage, findLoginRoot } from "./loginFields.ts";
import { warmAttachmentHost } from "../lib/attachmentWarmup.ts";

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

  // 로그인 입력칸이 있는 프레임을 찾는다(메인/iframe 모두 훑는다).
  //
  // ⚠ 예전엔 waitForURL(/access.broadcom.com/) 로 기다렸는데, 그 로그인 위젯 페이지는
  //   'load' 이벤트가 안 떠 URL 이 맞아도 90초 타임아웃났다. 또 위젯이 iframe 안에 있으면
  //   page 레벨 셀렉터가 못 뚫어 "입력칸 안 보임"으로 타임아웃난다. 그래서 프레임 전체를
  //   폴링해 입력칸이 보이는 프레임을 찾는다(load 이벤트와 무관).
  const root = await findLoginRoot(page, NAV_TIMEOUT_MS);
  if (root === null) {
    // 기기신뢰 무음 로그인으로 그새 세션이 살아났을 수 있다. 마지막으로 한 번 확인.
    if (await sessionEstablished(page)) return;
    throw new Error(`로그인 입력칸을 찾지 못했습니다.\n${await describeLoginPage(page)}`);
  }

  const username = root.locator(LOGIN_SEL.username).first();
  if ((await username.count()) > 0 && (await username.isVisible().catch(() => false))) {
    await username.fill(CREDENTIALS.username);
    // 기기 신뢰를 유지해야 다음 로그인에서 OTP를 다시 묻지 않는다.
    const remember = root.locator(LOGIN_SEL.rememberMe).first();
    if ((await remember.count()) > 0 && !(await remember.isChecked().catch(() => false))) {
      await remember.check().catch(() => undefined);
    }
    await root.locator(LOGIN_SEL.submit).first().click();
    await root.locator(LOGIN_SEL.password).first()
      .waitFor({ state: "visible", timeout: NAV_TIMEOUT_MS });
  }
  await root.locator(LOGIN_SEL.password).first().fill(CREDENTIALS.password);
  await root.locator(LOGIN_SEL.submit).first().click();

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
  // 저장 **전에** 첨부 저장소에 들러 그쪽 쿠키까지 받아 둔다. 안 그러면 서버가
  // 첨부를 대신 받아오지 못한다(lib/attachmentWarmup.ts 머리말 참고).
  const warmed = await warmAttachmentHost(context);
  if (!warmed) console.error("[login] 첨부 저장소 예열 실패 — 첨부는 원본으로 넘어갑니다");
  const state = await context.storageState({ path });
  saveDeviceState(state as StorageState, deviceFileForTeam(teamId));
  return path;
}
