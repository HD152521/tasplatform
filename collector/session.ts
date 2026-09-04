/**
 * 세션 계층.
 *
 * MFA 때문에 무인 재로그인은 불가능하다. 세션이 끊기면 반드시 예외로 전파해서
 * 상위에서 'session_expired' 로 기록되게 한다. 빈 결과로 흘려보내면
 * '새 답변 없음'과 구분되지 않아 도구를 믿을 수 없게 된다.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { API_HEADERS, API_ORIGIN, NAV_TIMEOUT_MS, PORTAL_HOME, SESSION_FILE } from "../lib/config.ts";

export class SessionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionExpiredError";
  }
}

export class SessionMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionMissingError";
  }
}

/** Windows headed 실행이 간헐적으로 크래시해서 옵션을 순서대로 시도한다. */
const LAUNCH_VARIANTS: Array<{ args?: string[] }> = [
  { args: ["--disable-gpu"] },
  {},
  { args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] },
];

const VIEWPORT = { width: 1600, height: 950 } as const;

export interface OpenedSession {
  browser: Browser;
  context: BrowserContext;
  close: () => Promise<void>;
}

export async function launchBrowser(headless: boolean): Promise<Browser> {
  let lastError: unknown;
  for (const variant of LAUNCH_VARIANTS) {
    try {
      return await chromium.launch({ headless, ...variant });
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`브라우저를 띄우지 못했습니다: ${String(lastError)}`);
}

/** 저장된 세션으로 컨텍스트를 연다. 세션 파일이 없으면 SessionMissingError. */
export async function openSavedSession(sessionFile = SESSION_FILE): Promise<OpenedSession> {
  const path = resolve(sessionFile);
  if (!existsSync(path)) {
    throw new SessionMissingError(
      `세션 파일이 없습니다: ${path}\n  먼저 'npm run login' 으로 로그인하세요.`,
    );
  }

  const browser = await launchBrowser(true);
  const context = await browser.newContext({ storageState: path, viewport: VIEWPORT });
  return {
    browser,
    context,
    close: async () => {
      await browser.close().catch(() => undefined);
    },
  };
}

/**
 * 포털을 한 번 열어 SSO 재확인을 태운 뒤 세션 유효성을 확인한다.
 * 유효하지 않으면 SessionExpiredError.
 */
export async function ensureSessionValid(context: BrowserContext): Promise<void> {
  // 1차: API 한 번만 두드려 본다.
  // 포털 홈을 여는 것만으로 SPA 부팅에 30건 가까운 요청이 나가므로,
  // 세션이 멀쩡한 대부분의 경우에는 이 한 건으로 끝낸다.
  if (await sessionAlive(context)) return;

  // 2차: 포털을 열어 SSO 무음 갱신을 태운다.
  //
  // 갱신은 즉시 끝나지 않는다. 실측상 토큰 교환(oktaoidcenduserauth)까지
  // 스무 번 남짓 요청이 오가므로, 한 번만 확인하고 포기하면 멀쩡한 세션도
  // 만료로 잘못 판정한다. 짧은 간격으로 여러 번 확인한다.
  const page = await context.newPage();
  try {
    await page.goto(PORTAL_HOME, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    const deadline = Date.now() + SSO_REFRESH_WAIT_MS;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2000);
      if (await sessionAlive(context)) return;
    }
  } finally {
    await page.close().catch(() => undefined);
  }

  throw new SessionExpiredError(
    "세션이 만료되었습니다. 웹 화면의 /login 에서 다시 로그인하거나 'npm run login' 을 실행하세요.",
  );
}

/** SSO 무음 갱신을 기다리는 시간. */
const SSO_REFRESH_WAIT_MS = 40_000;

async function sessionAlive(context: BrowserContext): Promise<boolean> {
  const response = await context.request.get(`${API_ORIGIN}/account_service/issessionvalid`, {
    headers: API_HEADERS,
  });
  return response.status() === 200;
}

/** 갱신된 쿠키를 다시 저장해 다음 실행에서 재사용한다. */
export async function persistSession(
  context: BrowserContext,
  sessionFile = SESSION_FILE,
): Promise<void> {
  await context.storageState({ path: resolve(sessionFile) });
}
