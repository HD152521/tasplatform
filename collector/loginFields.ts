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
