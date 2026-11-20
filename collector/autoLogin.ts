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
  DEFAULT_TEAM_ID,
  NAV_TIMEOUT_MS,
  PORTAL_HOME,
  deviceFileForTeam,
  sessionFileForTeam,
} from "../lib/config.ts";
import { saveDeviceState, type StorageState } from "../lib/browserIdentity.ts";
import { LOGIN_SEL, describeLoginPage, findLoginRoot, readLoginError } from "./loginFields.ts";
import { LoginAttemptError, OtpRequiredError, rejectionMessage } from "../lib/loginOutcome.ts";
import { warmAttachmentHost } from "../lib/attachmentWarmup.ts";

// OtpRequiredError 는 lib/loginOutcome.ts 가 정본이다 — 잠금 방지 카운터(lib/loginGuard.ts)가
// "OTP 는 비밀번호가 통과한 것" 으로 판정해야 해서 판정 쪽에 둔다. 여기서 쓰던 이름은
// 그대로 내보낸다(collector/login.ts 등이 이 경로로 가져간다).
export { OtpRequiredError };

/** 로그인에 쓸 자격. .env 또는 DB 에서 온다(lib/portalCredentials.ts). */
export interface LoginCredentials {
  readonly username: string;
  readonly password: string;
}

export class CredentialsMissingError extends Error {
  constructor() {
    super(
      "자동 로그인 계정이 설정되지 않았습니다.\n" +
        "  설정 화면(/settings/account)에서 계정을 저장하거나, .env 에 SR_USERNAME / SR_PASSWORD 를\n" +
        "  넣거나, 'npm run login' 으로 직접 로그인하세요.",
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
  // 이동 중에는 실행 컨텍스트가 사라져 evaluate 가 던진다
  // ("Execution context was destroyed, most likely because of a navigation").
  //
  // 비밀번호를 넣은 직후 SSO 리다이렉트가 몇 번 도는데, 그 사이에 이걸 부르면
  // **로그인 전체가 그 예외로 끝났다.** 판별용 코드가 로그인을 깨뜨리는 셈이다 —
  // 실제로 `npm run refresh` 가 그렇게 실패했다.
  //
  // 못 보면 false 로 둔다. 부르는 쪽이 1.5초 뒤 다시 묻고(아래 폴링 루프), 진짜 OTP
  // 화면이면 URL(factorselection)이나 다음 회차에서 잡힌다. 같은 위험을 아는
  // lib/loginFlow.ts 의 다른 자리도 이미 .catch 로 막아 두었다.
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
  }).catch(() => false);
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
 *
 * 성공하면 그냥 돌아온다. 실패는 **왜 실패했는지로 갈라서** 던진다. 잠금 방지
 * 카운터(lib/loginGuard.ts)가 그 종류로 "셀 것 / 세지 않을 것" 을 판단하기 때문이다.
 *
 *   OtpRequiredError            비밀번호는 통과. 사람이 OTP 를 넣어야 한다
 *   LoginAttemptError(rejected) 자격 거절 — 다시 보내면 IdP 실패 횟수만 오른다
 *   LoginAttemptError(locked)   이미 잠겼다 — 더 찔러서 잠금을 늘리지 않는다
 *   LoginAttemptError(expired)  비밀번호 만료 — 사람이 바꿔야 한다
 *   LoginAttemptError(failed)   그 외. passwordSubmitted 로 "비번을 넣었는지" 를 구분한다
 *
 * 자격은 인자로 받는다. 전에는 모듈 로드 시점의 .env 상수(CREDENTIALS)를 직접 읽었는데,
 * 그러면 화면에서 비밀번호를 바꿔도(DB) 수집기가 옛 값을 쓴다.
 */
export async function performCredentialLogin(
  page: Page,
  credentials: LoginCredentials,
): Promise<void> {
  if (credentials.username === "" || credentials.password === "") {
    throw new CredentialsMissingError();
  }

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
    await username.fill(credentials.username);
    // 기기 신뢰를 유지해야 다음 로그인에서 OTP를 다시 묻지 않는다.
    const remember = root.locator(LOGIN_SEL.rememberMe).first();
    if ((await remember.count()) > 0 && !(await remember.isChecked().catch(() => false))) {
      await remember.check().catch(() => undefined);
    }
    await root.locator(LOGIN_SEL.submit).first().click();
    try {
      await root.locator(LOGIN_SEL.password).first()
        .waitFor({ state: "visible", timeout: NAV_TIMEOUT_MS });
    } catch (error) {
      // 비밀번호 칸이 안 뜬 이유가 **아이디 거절**일 수 있다. 전에는 90초 기다린 뒤
      // "입력칸 없음" 으로 끝나서, 틀린 아이디로 영원히 재시도했다.
      const rejection = await readLoginError(page);
      if (rejection !== null) {
        throw new LoginAttemptError(rejection.kind, rejectionMessage(rejection), {
          // 비번은 아직 안 넣었지만 IdP 는 자격을 판정했다 — 거절은 세어야 한다.
          passwordSubmitted: false,
          hint: rejection.hint,
        });
      }
      throw error;
    }
  }
  await root.locator(LOGIN_SEL.password).first().fill(credentials.password);
  await root.locator(LOGIN_SEL.submit).first().click();

  // ── 이 줄 아래의 실패는 모두 "비밀번호를 제출한" 실패다(passwordSubmitted: true).
  //    그래야 잠금 방지 카운터가 제대로 센다.

  // 세션 발급·OTP·거절 중 먼저 오는 쪽을 기다린다. OTP 는 우회하지 않고 사람에게 넘긴다.
  const deadline = Date.now() + NAV_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await sessionEstablished(page)) return;
    if (await looksLikeOtpScreen(page)) throw new OtpRequiredError();
    const rejection = await readLoginError(page);
    if (rejection !== null) {
      throw new LoginAttemptError(rejection.kind, rejectionMessage(rejection), {
        passwordSubmitted: true,
        hint: rejection.hint,
      });
    }
    await page.waitForTimeout(1500);
  }
  throw new LoginAttemptError("failed", "로그인 후 세션이 발급되지 않았습니다 (타임아웃).", {
    passwordSubmitted: true,
  });
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
