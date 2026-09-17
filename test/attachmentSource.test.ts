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
