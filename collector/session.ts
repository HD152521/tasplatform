/**
 * 세션 계층.
 *
 * MFA 때문에 무인 재로그인은 불가능하다. 세션이 끊기면 반드시 예외로 전파해서
 * 상위에서 'session_expired' 로 기록되게 한다. 빈 결과로 흘려보내면
 * '새 답변 없음'과 구분되지 않아 도구를 믿을 수 없게 된다.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
// playwright-core 로 통일한다. 컨테이너에서는 @sparticuz/chromium 번들 바이너리를 구동하고,
// 로컬에서는 (같은 버전의) playwright 패키지가 설치해 둔 실제 브라우저를 그대로 찾아 띄운다.
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import {
  API_HEADERS,
  API_ORIGIN,
  DEFAULT_TEAM_ID,
  NAV_TIMEOUT_MS,
  PORTAL_HOME,
  deviceFileForTeam,
  sessionFileForTeam,
} from "../lib/config.ts";
import {
  saveDeviceState,
  sessionContextOptions,
  type StorageState,
} from "../lib/browserIdentity.ts";
import { planBrowserLaunch } from "./launchPlan.ts";

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

export interface OpenedSession {
  browser: Browser;
  context: BrowserContext;
  close: () => Promise<void>;
}

/**
 * 브라우저 실행 단일 창구.
 *
 * 컨테이너/로컬 어느 쪽인지는 planBrowserLaunch 가 env 로 판단한다(collector/launchPlan.ts).
 * 컨테이너면 @sparticuz/chromium 번들 바이너리로, 로컬이면 Playwright 가 설치한 실제
 * 브라우저로 띄운다. headless 인자는 로컬 headed 로그인(사람+OTP)을 위해 그대로 존중한다.
 */
export async function launchBrowser(headless: boolean): Promise<Browser> {
  const plan = planBrowserLaunch(headless, process.env);

  if (plan.bundled) {
    // 컨테이너 경로: @sparticuz/chromium 번들 바이너리 + playwright-core.
    //
    // 버전 짝맞춤(중요): @sparticuz/chromium 의 major = 번들 Chromium major 이고, 이는
    // playwright-core 가 구동하는 Chromium major 와 반드시 같아야 CDP 프로토콜이 맞물린다.
    //   playwright-core 1.55.1     → Chromium 140.0.7339.186
    //   @sparticuz/chromium 140.0.0 → Chromium 140
    // 둘 다 major 140 이라 짝이 맞다. sparticuz 는 자체 .so 를 /tmp 로 풀고 LD_LIBRARY_PATH 를
    // 앞세워 cflinuxfs4 에서 apt·root 없이 돈다(브라우저가 패키지 안에 들어 있음).
    // 주의: /tmp 추출물 ~250MB 는 1GB 디스크엔 들어가나 512MB RAM 은 빠듯하다 —
    //       워커 메모리를 1G 로 올릴 것을 권장(manifest 는 여기서 건드리지 않는다).
    // sparticuz 는 무거우므로 컨테이너 경로에서만 지연 로드한다.
    const sparticuz = (await import("@sparticuz/chromium")).default;
    // 그래픽 스택(swiftshader/WebGL)을 끈다. 로그인·수집엔 WebGL 이 필요 없고,
    // 끄면 swiftshader.tar.br 를 /tmp 로 풀지 않아 추출 용량과 메모리를 아낀다(512MB 압박 완화).
    // 반드시 executablePath() 전에 설정해야 추출 단계에 반영된다.
    sparticuz.setGraphicsMode = false;
    return chromium.launch({
      args: sparticuz.args,
      executablePath: await sparticuz.executablePath(),
      headless: true,
    });
  }

  // 로컬 경로: Playwright 가 설치한 실제 브라우저. Windows headed 크래시 대비로 옵션을 순차 시도.
  let lastError: unknown;
  for (const variant of LAUNCH_VARIANTS) {
    try {
      return await chromium.launch({ headless: plan.headless, ...variant });
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`브라우저를 띄우지 못했습니다: ${String(lastError)}`);
}

/**
 * 저장된 세션으로 컨텍스트를 연다. 세션 파일이 없으면 SessionMissingError.
 * teamId 를 생략하면 기본 팀의 세션 파일(기존 SESSION_FILE)을 그대로 쓴다.
 */
export async function openSavedSession(teamId: string = DEFAULT_TEAM_ID): Promise<OpenedSession> {
  const path = resolve(sessionFileForTeam(teamId));
  if (!existsSync(path)) {
    throw new SessionMissingError(
      `세션 파일이 없습니다: ${path}\n  먼저 'npm run login' 으로 로그인하세요.`,
    );
  }

  // launchBrowser 가 이미 살아있는 브라우저를 돌려준 뒤 newContext 가 throw 하면 그 브라우저가
  // 닫히지 않아 프로세스가 샌다(Node 가 종료 못 함). 컨텍스트 생성 실패 시 반드시 닫는다.
  const browser = await launchBrowser(true);
  try {
    const context = await browser.newContext(sessionContextOptions(browser, path));
    return {
      browser,
      context,
      close: async () => {
        await browser.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
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

/**
 * 갱신된 쿠키를 다시 저장해 다음 실행에서 재사용한다.
 * 기기 신뢰 쿠키도 같이 갱신한다 — 서버가 회전시키면 옛 값이 남으면 안 된다.
 * teamId 를 생략하면 기본 팀의 파일(기존 SESSION_FILE/DEVICE_FILE)에 저장한다.
 */
export async function persistSession(
  context: BrowserContext,
  teamId: string = DEFAULT_TEAM_ID,
): Promise<void> {
  const state = await context.storageState({ path: resolve(sessionFileForTeam(teamId)) });
  saveDeviceState(state as StorageState, deviceFileForTeam(teamId));
}
