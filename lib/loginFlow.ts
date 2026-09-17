/**
 * 서버에서 브라우저를 몰아 로그인시키는 흐름.
 *
 * 팀원이 웹 화면에 아이디/비번을 넣으면 서버가 헤드리스 브라우저로 대신 로그인한다.
 * OTP가 필요하면 흐름을 붙잡아 둔 채 화면에 코드 입력을 요청하고,
 * 받은 코드를 같은 브라우저에 이어서 넣는다.
 *
 * 설계 원칙
 *  - 자격증명은 절대 저장하지 않는다. 요청 처리 중에만 메모리에 있고 로그에도 남기지 않는다.
 *  - 성공하면 세션 파일만 남는다. 수집기가 쓰는 그 파일이다.
 *  - 흐름은 TTL 이 지나면 브라우저째 정리한다. 방치된 세션이 쌓이지 않게.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { DEFAULT_TEAM_ID, NAV_TIMEOUT_MS, PORTAL_HOME, deviceFileForTeam, sessionFileForTeam } from "./config.ts";
import { loginContextOptions, saveDeviceState, type StorageState } from "./browserIdentity.ts";
import { launchBrowser } from "../collector/session.ts";
import { LOGIN_SEL, describeLoginPage, findLoginRoot } from "../collector/loginFields.ts";

const FLOW_TTL_MS = 10 * 60 * 1000;
const STEP_TIMEOUT_MS = 60_000;

const SEL = {
  username: "#usernameInput, input[name='userName']",
  rememberMe: "#rememberMe",
  password: "input[type='password']",
  submit: "button[type='submit']",
  otp: "input[autocomplete='one-time-code'], input[name*='otp' i], input[id*='otp' i]",
} as const;

export type LoginResult =
  | { status: "done" }
  | { status: "otp_required"; flowId: string; hint: string }
  | { status: "error"; message: string };

interface Flow {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  createdAt: number;
  /** 어느 팀(공용 계정)의 로그인인지. 세션·기기신뢰 파일 경로를 결정한다. */
  teamId: string;
}

/** 진행 중인 로그인 흐름. 개발 모드의 모듈 재적재에도 살아남도록 전역에 둔다. */
const flows: Map<string, Flow> = ((globalThis as Record<string, unknown>).__srLoginFlows ??=
  new Map()) as Map<string, Flow>;

function sweepExpired(): void {
  const now = Date.now();
  for (const [id, flow] of flows) {
    if (now - flow.createdAt > FLOW_TTL_MS) {
      flows.delete(id);
      void flow.browser.close().catch(() => undefined);
    }
  }
}

function signedIn(page: Page): boolean {
  return page.url().includes("wolkenservicedesk.com") && !page.url().includes("/login-sso");
}

/**
 * OTP 입력칸을 찾는다.
 *
 * 표준 속성(one-time-code 등)이 없을 수 있어, 안내 문구가 있고 보이는 텍스트 입력이
 * 하나뿐이면 그것을 OTP 칸으로 본다.
 */
function otpLocator(page: Page) {
  return page.locator(SEL.otp).first();
}

async function hasOtpInput(page: Page): Promise<boolean> {
  if ((await page.locator(SEL.otp).count()) > 0) return true;
  return page.evaluate(() => {
    const text = (document.body?.innerText ?? "").toLowerCase();
    const mentionsCode =
      text.includes("security code") ||
      text.includes("verification code") ||
      text.includes("one-time") ||
      text.includes("otp");
    const typed = [...document.querySelectorAll("input")].filter(
      (el) => Boolean(el.offsetParent) && ["text", "tel", "number"].includes(el.type),
    );
    return mentionsCode && typed.length === 1;
  });
}

/** 보이는 텍스트 입력이 하나뿐일 때의 대체 입력칸. */
function fallbackCodeInput(page: Page) {
  return page.locator("input[type='text'], input[type='tel'], input[type='number']").first();
}

/**
 * 인증 방식 선택 화면("Confirm Your Identity / Select a way to sign in").
 *
 * 실측: 옵션들이 button 이 아니라 목록 행이라 버튼 탐색으로는 잡히지 않는다.
 * (화면의 유일한 button 은 Cancel 이다) 그래서 문구로 찾아 누른다.
 *
 * 우선순위는 이메일이다. biometrics 는 FIDO 라 서버에서 처리할 수 없고,
 * mobile app 은 인증 앱을 등록한 경우에만 쓸 수 있다.
 */
const FACTOR_OPTIONS = [
  /Email\b[^\n]*security code/i,
  /code from\s+mobile app/i,
] as const;

async function onFactorSelection(page: Page): Promise<boolean> {
  if (page.url().includes("factorselection")) return true;
  return page
    .evaluate(() =>
      (document.body?.innerText ?? "").toLowerCase().includes("select a way to sign in"),
    )
    .catch(() => false);
}

async function chooseFactor(page: Page): Promise<boolean> {
  if (!(await onFactorSelection(page))) return false;
  for (const pattern of FACTOR_OPTIONS) {
    const option = page.getByText(pattern).first();
    if ((await option.count()) === 0) continue;
    await option.click({ timeout: 5000 }).catch(() => undefined);
    return true;
  }
  return false;
}

/** 화면에 보이는 버튼 라벨. 진단과 단계 진행에 함께 쓴다. */
async function visibleButtons(page: Page): Promise<string[]> {
  return page
    .evaluate(() =>
      [...document.querySelectorAll("button, input[type=submit], a[role=button]")]
        .filter((el) => Boolean((el as HTMLElement).offsetParent))
        .map((el) =>
          ((el as HTMLInputElement).value || el.textContent || "").trim().slice(0, 40),
        )
        .filter((t) => t !== ""),
    )
    .catch(() => [] as string[]);
}

/**
 * 비밀번호 다음에 곧바로 OTP 입력창이 나오지 않는 경우가 있다.
 * 실측 흐름상 EMAIL_OTP_SELECTION 단계(방식 선택 / 코드 발송)가 끼어든다.
 * 그 화면으로 보이면 발송 버튼을 눌러 다음 단계로 넘긴다.
 */
const ADVANCE_LABEL = /email|send|continue|next|verify|otp|code|proceed|submit/i;

async function tryAdvance(page: Page, clicked: Set<string>): Promise<boolean> {
  for (const label of await visibleButtons(page)) {
    if (clicked.has(label) || !ADVANCE_LABEL.test(label)) continue;
    clicked.add(label);
    const button = page.getByRole("button", { name: label, exact: false }).first();
    if ((await button.count()) === 0) continue;
    await button.click({ timeout: 5000 }).catch(() => undefined);
    return true;
  }
  return false;
}

/** 막혔을 때 화면이 무엇인지 알려준다. 추측 대신 근거로 고치기 위해서다. */
export interface StuckInfo {
  url: string;
  heading: string;
  buttons: string[];
  inputs: string[];
  screenshot: string | null;
}

async function describe(page: Page): Promise<StuckInfo> {
  const heading = await page
    .evaluate(() => {
      const el = document.querySelector("h1, h2, h3, [role=heading]");
      return (el?.textContent ?? document.title ?? "").trim().slice(0, 120);
    })
    .catch(() => "");

  const inputs = await page
    .evaluate(() =>
      [...document.querySelectorAll("input")]
        .filter((el) => Boolean(el.offsetParent))
        .map((el) => `${el.type}${el.name ? `[name=${el.name}]` : ""}${el.id ? `#${el.id}` : ""}`),
    )
    .catch(() => [] as string[]);

  let screenshot: string | null = null;
  try {
    const path = resolve("data/login-debug.png");
    mkdirSync(dirname(path), { recursive: true });
    await page.screenshot({ path, fullPage: true });
    screenshot = path;
  } catch {
    screenshot = null;
  }

  return { url: page.url(), heading, buttons: await visibleButtons(page), inputs, screenshot };
}

export class LoginStuckError extends Error {
  readonly info: StuckInfo;
  constructor(info: StuckInfo) {
    super(
      `로그인 화면에서 다음 단계로 넘어가지 못했습니다.
` +
        `  화면: ${info.heading || "(제목 없음)"}
` +
        `  주소: ${info.url}
` +
        `  버튼: ${info.buttons.join(" / ") || "(없음)"}
` +
        `  입력: ${info.inputs.join(" / ") || "(없음)"}` +
        (info.screenshot ? `
  화면 캡처: ${info.screenshot}` : ""),
    );
    this.name = "LoginStuckError";
    this.info = info;
  }
}

/** OTP 화면에 쓸 짧은 안내. 코드가 어디로 갔는지 알려준다. */
async function otpHint(page: Page): Promise<string> {
  const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  const masked = /[A-Za-z0-9*]+@[A-Za-z0-9.*-]+\.[A-Za-z]{2,}/.exec(text);
  return masked ? `${masked[0]} 으로 발송된 코드를 입력하세요.` : "발송된 인증 코드를 입력하세요.";
}

/** 포털 복귀 / OTP 입력 중 먼저 오는 쪽을 기다린다. 중간 단계는 눌러서 넘긴다. */
async function settle(page: Page): Promise<"done" | "otp"> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  const clicked = new Set<string>();

  while (Date.now() < deadline) {
    if (signedIn(page)) return "done";
    if (await hasOtpInput(page)) return "otp";
    // 방식 선택 화면이 먼저 뜬다. 이메일 옵션을 눌러 코드 발송 단계로 넘긴다.
    if (await chooseFactor(page)) {
      await page.waitForTimeout(3000);
      continue;
    }
    if (await tryAdvance(page, clicked)) {
      await page.waitForTimeout(2500);
      continue;
    }
    await page.waitForTimeout(1200);
  }
  throw new LoginStuckError(await describe(page));
}

async function saveSession(context: BrowserContext, teamId: string): Promise<void> {
  const path = resolve(sessionFileForTeam(teamId));
  mkdirSync(dirname(path), { recursive: true });
  const state = await context.storageState({ path });
  // 기기 신뢰 쿠키를 따로 남겨 다음 로그인이 OTP 를 건너뛰게 한다.
  saveDeviceState(state as StorageState, deviceFileForTeam(teamId));
}

async function finish(flowId: string, flow: Flow): Promise<void> {
  await saveSession(flow.context, flow.teamId);
  flows.delete(flowId);
  await flow.browser.close().catch(() => undefined);
}

/**
 * 1단계: 아이디/비번 제출.
 * teamId 를 생략하면 기본 팀(공용 계정)으로 로그인한다.
 */
export async function startLogin(
  username: string,
  password: string,
  teamId: string = DEFAULT_TEAM_ID,
): Promise<LoginResult> {
  sweepExpired();

  let flow: Flow | null = null;
  // 브라우저를 지역변수에 먼저 담는다. launchBrowser 성공 후 newContext/newPage 가 throw 하면
  // flow 는 아직 null 이라 예전 코드는 브라우저를 못 닫아 프로세스가 샜다. catch 에서 browser 로
  // 직접 닫는다(flow 유무와 무관하게).
  let browser: Browser | null = null;
  try {
    // 실행 창구는 collector/session.ts 로 단일화한다. 컨테이너면 @sparticuz/chromium
    // (headless)로, 로컬이면 설치된 브라우저로 뜬다. 서버 주도 로그인은 항상 headless.
    browser = await launchBrowser(true);
    const context = await browser.newContext(loginContextOptions(browser, teamId));
    const page = await context.newPage();
    flow = { browser, context, page, createdAt: Date.now(), teamId };

    await page.goto(PORTAL_HOME, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });

    // 로그인 입력칸이 있는 프레임을 찾는다(메인/iframe 모두 훑는다).
    // ⚠ waitForURL(/access.broadcom.com/) 는 쓰지 않는다 — 그 로그인 위젯 페이지의 'load'
    //   이벤트가 안 떠 URL 이 맞아도 타임아웃난다. 위젯이 iframe 안일 수도 있어 page 레벨
    //   셀렉터로는 못 뚫는다. 프레임 전체 폴링이 두 경우를 모두 잡는다.
    const root = await findLoginRoot(page, NAV_TIMEOUT_MS);
    if (root === null) {
      throw new Error(`로그인 입력칸을 찾지 못했습니다.\n${await describeLoginPage(page)}`);
    }

    // 기기를 기억하고 있으면 아이디 단계를 건너뛰고 바로 비밀번호를 묻는다(둘 중 먼저 뜨는 쪽).
    const usernameField = root.locator(LOGIN_SEL.username).first();
    if ((await usernameField.count()) > 0 && (await usernameField.isVisible().catch(() => false))) {
      await usernameField.fill(username);
      // 기기 신뢰를 유지해야 다음 로그인에서 OTP를 다시 묻지 않는다.
      const remember = root.locator(LOGIN_SEL.rememberMe).first();
      if ((await remember.count()) > 0 && !(await remember.isChecked().catch(() => false))) {
        await remember.check().catch(() => undefined);
      }
      await root.locator(LOGIN_SEL.submit).first().click();
      await root.locator(LOGIN_SEL.password).first()
        .waitFor({ state: "visible", timeout: NAV_TIMEOUT_MS });
    }
    await root.locator(LOGIN_SEL.password).first().fill(password);
    await root.locator(LOGIN_SEL.submit).first().click();

    const outcome = await settle(page);
    if (outcome === "done") {
      const id = randomUUID();
      await finish(id, flow);
      return { status: "done" };
    }

    const flowId = randomUUID();
    flows.set(flowId, flow);
    return { status: "otp_required", flowId, hint: await otpHint(page) };
  } catch (error) {
    if (browser !== null) await browser.close().catch(() => undefined);
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

/** 2단계: OTP 제출. */
export async function submitOtp(flowId: string, code: string): Promise<LoginResult> {
  sweepExpired();

  const flow = flows.get(flowId);
  if (flow === undefined) {
    return { status: "error", message: "로그인 대기 시간이 지났습니다. 처음부터 다시 시도하세요." };
  }

  try {
    const { page } = flow;
    let field = otpLocator(page);
    if ((await field.count()) === 0) field = fallbackCodeInput(page);
    if ((await field.count()) === 0) {
      return { status: "error", message: "인증 코드 입력란을 찾지 못했습니다." };
    }
    await field.fill(code);
    await page.click(SEL.submit).catch(async () => {
      await page.keyboard.press("Enter");
    });

    const outcome = await settle(page);
    if (outcome === "otp") {
      return { status: "error", message: "코드가 맞지 않는 것 같습니다. 다시 입력해 주세요." };
    }

    await finish(flowId, flow);
    return { status: "done" };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

/** 화면을 떠날 때 붙잡고 있던 브라우저를 정리한다. */
export async function cancelLogin(flowId: string): Promise<void> {
  const flow = flows.get(flowId);
  if (flow === undefined) return;
  flows.delete(flowId);
  await flow.browser.close().catch(() => undefined);
}
