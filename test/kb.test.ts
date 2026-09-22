import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeEntities,
  issueLine,
  matchProducts,
  parseArticle,
  parseArticleUrl,
  parseChips,
  parseSections,
  parseSitemap,
  parseSitemapIndex,
  stripHtml,
} from "../lib/kb.ts";
import { buildRelevanceUser, parseVerdict } from "../lib/kbPrompt.ts";
import { pickTargets } from "../collector/collect-kb.ts";

const NEWLINE = String.fromCharCode(10);
const lines = (...parts: string[]): string => parts.join(NEWLINE);

/**
 * 실제 Broadcom 문서의 "모양"만 본뜬 합성 HTML 이다.
 * 구조(클래스명·섹션 이름·제품 태그 위치)는 2026-09-22 실측한 것과 같게 두었다.
 */
const ARTICLE = lines(
  "<html><head>",
  '<meta name="description" content="Gorouter drops websocket upgrade after &amp; idle timeout">',
  '<script type="application/ld+json">',
  '{"headline":"Gorouter drops websocket","datePublished":"09-20-2026 23:26","dateModified":"09-21-2026 01:00"}',
  "</script></head><body>",
  '<span class="product-chip">VMware Tanzu Platform - Cloud Foundry</span>',
  '<span class="product-chip">VMware Tanzu RabbitMQ</span>',
  '<div class="article-detail-card">',
  '  <div class="article-detail-card-header"><h4 class="wolken-h4">Issue/Introduction</h4></div>',
  '  <div class="article-detail-card-content wolken-h5">',
  "    <p>Websocket connections are closed after 30 seconds.</p>",
  '    <div class="inner"><ul><li>Only on the shared router tier</li></ul></div>',
  "  </div>",
  "</div>",
  '<div class="article-detail-card">',
  '  <div class="article-detail-card-header"><h4 class="wolken-h4">Environment</h4></div>',
  '  <div class="article-detail-card-content wolken-h5"><p>TAS 4.0<br>Gorouter 0.300</p></div>',
  "</div>",
  '<div class="article-detail-card">',
  '  <div class="article-detail-card-header"><h4 class="wolken-h4">Resolution</h4></div>',
  '  <div class="article-detail-card-content wolken-h5"><p>Raise the idle timeout.</p></div>',
  "</div>",
  "</body></html>",
);

/* ------------------------------------------------------------------ *
 * 사이트맵
 * ------------------------------------------------------------------ */

test("사이트맵 인덱스에서 자식 주소를 순서대로 뽑는다", () => {
  const xml = lines(
    "<sitemapindex>",
    "<sitemap><loc>https://knowledge.broadcom.com/sitemap_1.xml</loc></sitemap>",
    "<sitemap><loc>https://knowledge.broadcom.com/sitemap_19.xml</loc></sitemap>",
    "</sitemapindex>",
  );
  const pages = parseSitemapIndex(xml);
  assert.equal(pages.length, 2);
  // 마지막 장이 가장 최신이다. 수집기는 뒤에서부터 가져간다.
  assert.ok(pages[pages.length - 1]?.endsWith("sitemap_19.xml"));
});

test("사이트맵에서 문서 id·slug·lastmod 를 뽑고 문서가 아닌 주소는 버린다", () => {
  const xml = lines(
    "<urlset>",
    "<url><loc>https://knowledge.broadcom.com/external/article/456529/some-title.html</loc>",
    "<lastmod>2026-09-21T01:00:00Z</lastmod></url>",
    "<url><loc>https://knowledge.broadcom.com/search</loc><lastmod>2026-09-21T01:00:00Z</lastmod></url>",
    "</urlset>",
  );
  const rows = parseSitemap(xml);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, 456529);
  assert.equal(rows[0]?.slug, "some-title");
  assert.equal(rows[0]?.lastmod, "2026-09-21T01:00:00Z");
});

test("문서 주소가 아니면 null", () => {
  assert.equal(parseArticleUrl("https://knowledge.broadcom.com/"), null);
  assert.equal(parseArticleUrl("https://knowledge.broadcom.com/external/article/abc/x.html"), null);
});

/* ------------------------------------------------------------------ *
 * 문서 파싱
 * ------------------------------------------------------------------ */

test("엔티티를 되돌리고 태그를 걷어낸다", () => {
  assert.equal(decodeEntities("A &amp; B&nbsp;C"), "A & B C");
  assert.equal(stripHtml("<p>one<br>two</p>"), lines("one", "two"));
});

test("제품 태그를 전부 뽑는다 — 한 문서에 여러 개 붙는다", () => {
  const chips = parseChips(ARTICLE);
  assert.deepEqual(chips, ["VMware Tanzu Platform - Cloud Foundry", "VMware Tanzu RabbitMQ"]);
});

test("본문 섹션 안에 div 가 중첩돼도 끝까지 가져온다", () => {
  const sections = parseSections(ARTICLE);
  const issue = sections.get("Issue/Introduction") ?? "";
  // 안쪽 div 의 첫 </div> 에서 잘리면 이 줄을 놓친다.
  assert.ok(issue.includes("Only on the shared router tier"), issue);
  assert.ok(issue.includes("Websocket connections are closed"));
  assert.equal(sections.get("Environment"), lines("TAS 4.0", "Gorouter 0.300"));
  assert.equal(sections.get("Resolution"), "Raise the idle timeout.");
});

test("제목은 잘리지 않은 meta description 을 쓴다", () => {
  const article = parseArticle(ARTICLE);
  // slug 는 40자에서 잘리고 headline 도 짧다. meta 가 전체 제목이다.
  assert.equal(article.title, "Gorouter drops websocket upgrade after & idle timeout");
  assert.equal(article.published, "09-20-2026 23:26");
  assert.equal(article.modified, "09-21-2026 01:00");
});

test("증상 첫 줄을 목록용으로 뽑는다", () => {
  assert.equal(
    issueLine(parseArticle(ARTICLE).sections),
    "Websocket connections are closed after 30 seconds.",
  );
});

/* ------------------------------------------------------------------ *
 * 우리 제품 판정
 * ------------------------------------------------------------------ */

test("우리 제품 태그를 알아본다", () => {
  // 태그 하나에 제품 하나. 좁은 이름(Cloud Foundry)이 Tanzu Platform 보다 먼저다.
  assert.deepEqual(matchProducts(["VMware Tanzu Platform - Cloud Foundry"]), ["TAS / Cloud Foundry"]);
  assert.deepEqual(matchProducts(["VMware Tanzu Platform Core"]), ["Tanzu Platform"]);
  assert.deepEqual(matchProducts(["VMware Tanzu RabbitMQ", "RabbitMQ"]), ["RabbitMQ"]);
});

test("우산 태그는 남기되 우산이라고 표시한다", () => {
  // Tanzu Data Suite 는 GemFire·Greenplum·Postgres 를 묶은 태그다. GemFire 문서가
  // 이 태그만 달고 오는 경우가 있어 버리지 않는다. 진짜 우리 일인지는 LLM 이 가른다.
  assert.deepEqual(matchProducts(["VMware Tanzu Data Suite"]), ["Tanzu Data Suite"]);
});

test("우산 태그에만 걸렸는데 제외 태그가 함께면 떨어뜨린다", () => {
  // 실측: Greenplum 문서가 "VMware Tanzu Data Suite" 를 함께 달고 와 GemFire 로 잡혔다.
  assert.deepEqual(matchProducts(["VMware Tanzu Data Suite", "VMware Tanzu Greenplum"]), []);
});

test("제외 태그가 있어도 좁은 제품이 걸렸으면 남긴다", () => {
  assert.deepEqual(
    matchProducts(["VMware GemFire", "VMware Tanzu Greenplum"]),
    ["GemFire"],
  );
});

test("우리 제품이 아닌 태그는 걸리지 않는다", () => {
  for (const chip of [
    "SITEMINDER",
    "Clarity PPM SaaS",
    "CA Test Data Manager (Data Finder / Grid Tools)",
    "VMware vCenter Server",
    "Automic Automation",
  ]) {
    assert.deepEqual(matchProducts([chip]), [], chip);
  }
});

test("slug 키워드 오탐이 제품 판정으로 새지 않는다", () => {
  // slug 로 거르면 staff-tasks 가 "-tas" 로 걸렸다. 제품 태그는 정규 제품명이라 안 걸린다.
  assert.deepEqual(matchProducts(["Autosys Workload Automation"]), []);
  assert.deepEqual(matchProducts(["CA Configuration Automation"]), []);
});

/* ------------------------------------------------------------------ *
 * 받아올 문서 고르기
 * ------------------------------------------------------------------ */

const entry = (id: number, lastmod: string) => ({
  id, lastmod, slug: `doc-${id}`, url: `https://knowledge.broadcom.com/external/article/${id}/d.html`,
});

test("처음 보는 문서는 받는다. 최신 id 부터.", () => {
  const picked = pickTargets([entry(10, "a"), entry(30, "a"), entry(20, "a")], new Map(), 10);
  assert.deepEqual(picked.map((e) => e.id), [30, 20, 10]);
});

test("우리 제품 문서가 개정되면 다시 받는다", () => {
  const seen = new Map([[10, { lastmod: "old", matched: "TAS / Cloud Foundry" }]]);
  assert.deepEqual(pickTargets([entry(10, "new")], seen, 10).map((e) => e.id), [10]);
});

test("우리 제품이 아닌 문서는 개정돼도 본문을 다시 받지 않는다", () => {
  // 제품 태그는 이미 캐시돼 있다. 하루 300건의 개정을 여기서 걸러낸다.
  const seen = new Map([[10, { lastmod: "old", matched: "" }]]);
  assert.deepEqual(pickTargets([entry(10, "new")], seen, 10), []);
});

test("내용이 그대로면 다시 받지 않는다", () => {
  const seen = new Map([[10, { lastmod: "same", matched: "TAS / Cloud Foundry" }]]);
  assert.deepEqual(pickTargets([entry(10, "same")], seen, 10), []);
});

test("한 회차 상한을 지킨다", () => {
  const many = [1, 2, 3, 4, 5].map((n) => entry(n, "a"));
  assert.equal(pickTargets(many, new Map(), 2).length, 2);
});

/* ------------------------------------------------------------------ *
 * 환경 적합성 판정
 * ------------------------------------------------------------------ */

test("판정과 이유를 읽는다", () => {
  const got = parseVerdict(lines("판정: match", "이유: TAS 4.0 은 우리가 쓰는 버전대입니다."));
  assert.equal(got.verdict, "match");
  assert.equal(got.why, "TAS 4.0 은 우리가 쓰는 버전대입니다.");
});

test("코드펜스와 영어 라벨도 읽는다", () => {
  const got = parseVerdict(lines("```", "verdict: NO", "reason: vCenter 전용 기능입니다.", "```"));
  assert.equal(got.verdict, "no");
  assert.equal(got.why, "vCenter 전용 기능입니다.");
});

test("판정을 못 읽으면 관련 없음이 아니라 확인 필요로 둔다", () => {
  // 모르는 것을 버리면 놓친다. 사람이 보게 남긴다.
  assert.equal(parseVerdict("무슨 말인지 모르겠습니다").verdict, "maybe");
  assert.equal(parseVerdict("판정: 아마도요").verdict, "maybe");
});

test("프롬프트에 우리 환경과 문서 섹션이 함께 실린다", () => {
  const article = parseArticle(ARTICLE);
  const user = buildRelevanceUser(article);
  assert.ok(user.includes("[우리 환경]"));
  assert.ok(user.includes("Tanzu Application Service"));
  assert.ok(user.includes("[Environment]"));
  assert.ok(user.includes("Gorouter 0.300"));
  // 비어 있는 섹션은 싣지 않는다.
  assert.ok(!user.includes("[Cause]"));
});

test("섹션이 길면 잘라 토큰을 아낀다", () => {
  const long = new Map([["Issue/Introduction", "x".repeat(500)]]);
  const user = buildRelevanceUser({ title: "t", products: ["p"], sections: long }, 100);
  assert.ok(user.includes("x".repeat(100)));
  assert.ok(!user.includes("x".repeat(101)));
});
