/**
 * 로그인 입력칸 찾기 — 프레임 인지.
 *
 * Broadcom 로그인 위젯(access.broadcom.com)은 상황에 따라 최상위 프레임이 아니라 iframe
 * 안에 렌더될 수 있다. page 레벨 셀렉터는 iframe 을 뚫지 못해 "입력칸이 안 보인다"로
 * 90초 타임아웃난다. 그래서 모든 프레임을 훑어 입력칸이 있는 프레임을 돌려준다.
 *
 * 실패하면 지어내지 않고, 지금 화면이 무엇인지(URL·프레임별 input 수)를 진단으로 남긴다 —
 * iframe 문제인지, 셀렉터가 바뀐 건지, 아직 포털에 머물러 있는지 바로 가려낸다.
 */
import type { Frame, Page } from "playwright-core";
import { classifyLoginText, type LoginRejection } from "../lib/loginOutcome.ts";

/** 로그인 폼 셀렉터. 위젯 변형(userName/username/email)까지 넓게 잡는다. */
export const LOGIN_SEL = {
  username:
    "#usernameInput, input[name='userName'], input[name='username'], input#username, input[type='email']",
  rememberMe: "#rememberMe, input[type='checkbox'][name*='remember' i]",
  password: "input[type='password']",
  submit: "button[type='submit'], input[type='submit']",
} as const;

/** page 또는 frame — 로그인 폼이 있는 곳. 둘 다 locator/fill/click 를 갖는다. */
export type LoginRoot = Page | Frame;

const FIELD_SELECTOR = `${LOGIN_SEL.username}, ${LOGIN_SEL.password}`;

/**
 * 로그인 입력칸(아이디 또는 비번)이 보이는 프레임을 찾는다. 메인 프레임과 모든 iframe 을
 * 폴링한다. timeoutMs 안에 못 찾으면 null.
 */
export async function findLoginRoot(page: Page, timeoutMs: number): Promise<LoginRoot | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const visible = await frame
        .locator(FIELD_SELECTOR)
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false);
      if (visible) return frame;
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

/**
 * 지금 화면이 **자격을 거절했는지** 읽는다. 아니면 null.
 *
 * 비밀번호를 제출한 뒤에만 부른다. 두 단계로 본다.
 *
 *   1. 오류 칸(role=alert / aria-live / class 에 error·alert)만 먼저 읽는다. 거기 글자가
 *      곧 "지금 벌어진 일" 이다 — 오탐이 가장 적다.
 *   2. 거기서 못 찾으면 본문 전체를 본다. 위젯이 오류를 평범한 div 로 그리는 변형이 있다.
 *
 * `innerText` 를 쓴다(textContent 아님). 로그인 위젯은 오류 칸을 **미리 그려 두고 숨기는**
 * 경우가 있어서, textContent 로 읽으면 아무 일도 없는 화면에서 "비밀번호 틀림" 을 읽는다.
 * innerText 는 숨은 요소를 빼고 돌려준다.
 *
 * 모든 프레임을 훑는다 — 위젯이 iframe 안일 수 있다(이 파일 머리말).
 * 화면을 읽다 터지면 null 로 둔다. **판별용 코드가 로그인을 깨뜨려선 안 된다**(이 레포에서
 * 실제로 한 번 그랬다. collector/autoLogin.ts looksLikeOtpScreen 주석 참고).
 */
export async function readLoginError(page: Page): Promise<LoginRejection | null> {
  const ERROR_SEL =
    "[role=alert], [aria-live], .error, .alert, [class*='error' i], [class*='alert' i], [class*='message' i]";

  for (const frame of page.frames()) {
    const alerts = await frame
      .evaluate((selector: string) => {
        const seen = [...document.querySelectorAll(selector)]
          .filter((el) => Boolean((el as HTMLElement).offsetParent))
          .map((el) => (el as HTMLElement).innerText ?? "");
        return seen.join("\n");
      }, ERROR_SEL)
      .catch(() => "");
    const fromAlert = classifyLoginText(alerts);
    if (fromAlert !== null) return fromAlert;
  }

  for (const frame of page.frames()) {
    const body = await frame
      .evaluate(() => document.body?.innerText ?? "")
      .catch(() => "");
    const fromBody = classifyLoginText(body);
    if (fromBody !== null) return fromBody;
  }
  return null;
}

/** 로그인 화면을 못 찾았을 때, 지금 무엇이 떠 있는지 사람이 읽을 진단 문자열. */
export async function describeLoginPage(page: Page): Promise<string> {
  const lines: string[] = [];
  lines.push(`현재 URL: ${page.url()}`);
  const title = await page.title().catch(() => "(제목 읽기 실패)");
  lines.push(`제목: ${title}`);
  const frames = page.frames();
  lines.push(`프레임 ${frames.length}개:`);
  for (const frame of frames) {
    const inputs = await frame.locator("input").count().catch(() => -1);
    const passwords = await frame.locator("input[type='password']").count().catch(() => -1);
    lines.push(`  - ${frame.url() || "(about:blank)"} : input ${inputs}개(비번칸 ${passwords})`);
  }
  return lines.join("\n");
}
