import { test } from "node:test";
import assert from "node:assert/strict";
import { WARMUP_URL, isAttachmentHost, warmAttachmentHost } from "../lib/attachmentWarmup.ts";
import { isAllowedHost } from "../lib/attachmentSource.ts";

test("예열 주소는 프록시가 허용하는 호스트다", () => {
  // 예열해 둔 쿠키를 실제로 쓰려면 프록시도 같은 호스트를 통과시켜야 한다.
  assert.ok(isAllowedHost(new URL(WARMUP_URL).hostname));
});

test("첨부 호스트를 알아본다", () => {
  assert.ok(isAttachmentHost("supportftp.broadcom.com"));
  assert.ok(isAttachmentHost(".supportftp.broadcom.com"));
  assert.ok(!isAttachmentHost("access.broadcom.com"));
  assert.ok(!isAttachmentHost("supportftp.broadcom.com.evil.test"));
});

/* ------------------------------------------------------------------ *
 * 예열
 * ------------------------------------------------------------------ */

/** 브라우저 컨텍스트 흉내. 실제 Playwright 를 띄우지 않는다. */
function fakeContext(cookies: Array<{ domain: string; name: string }>, opts: {
  gotoThrows?: boolean;
} = {}) {
  const closed: boolean[] = [];
  return {
    closed,
    async newPage() {
      return {
        async goto() { if (opts.gotoThrows === true) throw new Error("네트워크 끊김"); },
        async waitForURL() { /* 돌아옴 */ },
        async close() { closed.push(true); },
      };
    },
    async cookies() { return cookies; },
  };
}

test("첨부 호스트 쿠키를 받으면 예열 성공", async () => {
  const ctx = fakeContext([
    { domain: "supportftp.broadcom.com", name: "CrushAuth" },
    { domain: "access.broadcom.com", name: "sspsession" },
  ]);
  assert.equal(await warmAttachmentHost(ctx as never), true);
  assert.equal(ctx.closed.length, 1, "페이지를 닫아야 한다");
});

// nonce·redirect 만 받은 것은 OAuth 를 시작만 하고 끝내지 못한 상태다.
test("OAuth 임시 쿠키만 받으면 예열이 아니다", async () => {
  const ctx = fakeContext([
    { domain: "supportftp.broadcom.com", name: "auth_nonce" },
    { domain: "supportftp.broadcom.com", name: "auth_redir" },
  ]);
  assert.equal(await warmAttachmentHost(ctx as never), false);
});

test("쿠키가 하나도 없으면 실패", async () => {
  assert.equal(await warmAttachmentHost(fakeContext([]) as never), false);
});

// 예열 실패가 로그인을 막으면 안 된다. 첨부는 원본으로 튕길 뿐이고 수집은 무관하다.
test("중간에 터져도 던지지 않고 false 를 준다", async () => {
  const ctx = fakeContext([], { gotoThrows: true });
  assert.equal(await warmAttachmentHost(ctx as never), false);
  assert.equal(ctx.closed.length, 1, "터져도 페이지는 닫아야 한다");
});
