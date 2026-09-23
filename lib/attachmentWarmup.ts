/**
 * 첨부 저장소(supportftp) 세션 예열.
 *
 * 첨부 실물은 supportftp.broadcom.com 에 있는데, **로그인 과정이 그 호스트를 한 번도
 * 방문하지 않아** 세션 파일에 그쪽 쿠키가 생길 일이 없었다(실측: 세션 쿠키 도메인이
 * access.broadcom.com 과 wolkenservicedesk.com 뿐이었다). 그래서 서버가 첨부를 대신
 * 받아오지 못하고 매번 Broadcom 로그인으로 튕겼다.
 *
 * supportftp 는 같은 SSO(access.broadcom.com)를 쓴다. 이미 로그인된 브라우저로 한 번
 * 들르면 OAuth 왕복이 그 자리에서 끝나고 쿠키가 남는다. storageState() 는 도메인을
 * 가리지 않으므로 그대로 세션 파일에 들어간다.
 *
 * 서버에서 OAuth 를 재현하는 것보다 이쪽이 낫다 — 중간에 자바스크립트 리다이렉트가
 * 섞여 있어도 브라우저는 그냥 따라간다.
 */
import type { BrowserContext } from "playwright";

/** 들러서 쿠키를 받아올 주소. 파일이 아니라 목록 페이지라 부담이 적다. */
export const WARMUP_URL = "https://supportftp.broadcom.com/WebInterface/";

const WARMUP_TIMEOUT_MS = 45_000;

/** 이 호스트의 쿠키가 있으면 예열된 것으로 본다. */
export function isAttachmentHost(domain: string): boolean {
  const bare = domain.replace(/^\./, "").toLowerCase();
  return bare === "supportftp.broadcom.com";
}

/**
 * 로그인된 컨텍스트로 supportftp 에 한 번 들른다.
 *
 * **실패해도 로그인을 막지 않는다.** 예열이 안 되면 첨부는 예전처럼 원본으로
 * 튕길 뿐이고, 케이스 수집은 이 호스트와 무관하다.
 */
export async function warmAttachmentHost(context: BrowserContext): Promise<boolean> {
  let page;
  try {
    page = await context.newPage();
    await page.goto(WARMUP_URL, { waitUntil: "domcontentloaded", timeout: WARMUP_TIMEOUT_MS });
    // SSO 로 나갔다가 supportftp 로 돌아올 때까지 기다린다. 안 돌아와도 넘어간다.
    await page
      .waitForURL(/supportftp\.broadcom\.com/, { timeout: WARMUP_TIMEOUT_MS })
      .catch(() => undefined);

    const cookies = await context.cookies(WARMUP_URL);
    // nonce·redirect 같은 OAuth 임시값만 받은 것은 예열이 아니다.
    return cookies.some(
      (c) => isAttachmentHost(c.domain) && !/^auth_(nonce|redir)$/i.test(c.name),
    );
  } catch {
    return false;
  } finally {
    await page?.close().catch(() => undefined);
  }
}
