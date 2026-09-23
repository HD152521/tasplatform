/**
 * 첨부 다운로드 원본 URL 해석 검증.
 *
 * 클릭하면 Broadcom 으로 튀지 않고 서버가 대신 받아 스트리밍하려면, 먼저 docFullPath 를
 * "받아올 절대 URL" 로 안전하게 바꿔야 한다. 허용 호스트 밖·비 http 스킴은 null 로 막는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAttachmentUrl, isAllowedHost } from "../lib/attachmentSource.ts";

const API = "https://api-broadcomcms-software.wolkenservicedesk.com";

test("경로만 있는 값은 API_ORIGIN 에 붙인다", () => {
  assert.equal(
    resolveAttachmentUrl("/attachment/download/123", API),
    `${API}/attachment/download/123`,
  );
});

test("앞 슬래시가 없어도 붙인다", () => {
  assert.equal(
    resolveAttachmentUrl("attachment/download/123", API),
    `${API}/attachment/download/123`,
  );
});

test("Wolken 절대 URL 은 그대로 통과한다", () => {
  const u = "https://api-broadcomcms-software.wolkenservicedesk.com/x/y.pdf";
  assert.equal(resolveAttachmentUrl(u, API), u);
});

test("BOX 절대 URL 도 허용한다(첨부 실물 저장소)", () => {
  const u = "https://dl.boxcloud.com/abc/def/report.xlsx";
  assert.equal(resolveAttachmentUrl(u, API), u);
});

test("허용 목록 밖 호스트는 null(SSRF 차단)", () => {
  assert.equal(resolveAttachmentUrl("https://evil.example.com/a.pdf", API), null);
});

test("호스트 접미사 부분일치로 우회할 수 없다", () => {
  // "box.com.evil.com" 은 box.com 이 아니다.
  assert.equal(resolveAttachmentUrl("https://box.com.evil.com/a", API), null);
  assert.equal(isAllowedHost("box.com.evil.com"), false);
  assert.equal(isAllowedHost("dl.boxcloud.com"), true);
});

test("http/https 아닌 스킴은 null", () => {
  assert.equal(resolveAttachmentUrl("file:///etc/passwd", API), null);
  assert.equal(resolveAttachmentUrl("data:text/plain,hi", API), null);
  assert.equal(resolveAttachmentUrl("ftp://x.wolkenservicedesk.com/a", API), null);
});

test("빈 값·공백은 null", () => {
  assert.equal(resolveAttachmentUrl("", API), null);
  assert.equal(resolveAttachmentUrl("   ", API), null);
});

/* ------------------------------------------------------------------ *
 * supportftp — 첨부 실물이 있는 곳
 * ------------------------------------------------------------------ */

// 실측(첨부 450건): doc_path 가 **전부** supportftp.broadcom.com 인데 허용 목록에
// 없어 전건이 null 로 떨어졌다. 그러면 라우트가 404 JSON 을 내고, 화면의
// <a download> 가 그 JSON 을 첨부 이름으로 저장해 "사용할 수 없는 파일" 이 된다.
test("supportftp 첨부 경로를 통과시킨다", () => {
  const url = "https://supportftp.broadcom.com/WebInterface/redirect.html"
    + "?filePath=15588968/37076269/files_from_customer/logcache.png";
  assert.equal(resolveAttachmentUrl(url, API), url);
});

test("supportftp 가 넘기는 SSO 호스트도 통과시킨다", () => {
  // OAuth 왕복을 따라가려면 필요하다.
  assert.ok(isAllowedHost("access.broadcom.com"));
});

test("broadcom.com 을 통째로 열지는 않는다", () => {
  // 허용은 정확한 호스트 단위다. 아무 broadcom 하위 도메인이나 열면 SSRF 표면이 넓어진다.
  assert.ok(!isAllowedHost("broadcom.com"));
  assert.ok(!isAllowedHost("evil.broadcom.com"));
  assert.ok(!isAllowedHost("supportftp.broadcom.com.evil.test"));
});
