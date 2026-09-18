/**
 * 요약 텍스트 → Confluence storage(XHTML) 변환 검증.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toConfluenceStorage, escapeXml } from "../lib/confluenceStorage.ts";

test("헤딩은 <h2> 로, 문단은 <p> 로 바꾼다", () => {
  const out = toConfluenceStorage("문제 정의\n\n장애가 발생했다.\n원인 불명.");
  assert.match(out, /<h2>문제 정의<\/h2>/);
  assert.match(out, /<p>장애가 발생했다\.<br\/>원인 불명\.<\/p>/);
});

test("마크다운 파이프 표를 <table> 로 바꾸고 구분선은 건너뛴다", () => {
  const md = "| 구분 | 내용 |\n|---|---|\n| 환경 | TAS |";
  const out = toConfluenceStorage(md);
  assert.match(out, /<table><tbody>/);
  assert.match(out, /<th>구분<\/th><th>내용<\/th>/);
  assert.match(out, /<td>환경<\/td><td>TAS<\/td>/);
  assert.doesNotMatch(out, /---/);
});

test("XML 특수문자를 이스케이프한다", () => {
  assert.equal(escapeXml("a < b & c > d"), "a &lt; b &amp; c &gt; d");
  const out = toConfluenceStorage("a < b & c");
  assert.match(out, /a &lt; b &amp; c/);
});

test("빈 입력은 빈 문자열", () => {
  assert.equal(toConfluenceStorage(""), "");
  assert.equal(toConfluenceStorage("   \n\n  "), "");
});

test("알 수 없는 헤딩 문구는 문단으로 둔다(양식 밖 내용 보존)", () => {
  const out = toConfluenceStorage("임의 제목\n\n본문");
  assert.match(out, /<p>임의 제목<\/p>/);
  assert.doesNotMatch(out, /<h2>임의 제목<\/h2>/);
});
