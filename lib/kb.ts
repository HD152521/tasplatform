/**
 * Broadcom 기술문서(Knowledge Base) 파싱.
 *
 * 사이트맵과 문서 HTML 을 읽어 구조를 뽑는다. 네트워크는 건드리지 않는다 —
 * 그쪽은 kbFetch.ts 다. 여기를 순수하게 두어야 표본 HTML 로 테스트할 수 있다.
 *
 * 실측으로 확인한 것(2026-09-22):
 *   - sitemap.xml 은 자식 19개, 각 10,000건(마지막만 569건). 인증 불필요.
 *   - 문서 페이지는 SPA 가 아니라 서버 렌더링 HTML 이다. 헤드리스 브라우저가 필요 없다.
 *   - 본문은 .article-detail-card 단위로 Issue/Introduction · Environment · Cause ·
 *     Resolution 이 들어온다.
 *   - 제품은 .product-chip 으로 온다. 한 문서에 여러 개 붙는다(표본 59건에 109개).
 */

/** 사이트맵 한 줄. */
export interface KbEntry {
  /** 문서 id. URL 의 /article/{id}/ 부분. */
  readonly id: number;
  readonly slug: string;
  readonly url: string;
  /** 사이트맵이 알려주는 최종 수정 시각. 개정 판정에 쓴다. */
  readonly lastmod: string;
}

/** 문서 한 건에서 뽑아낸 것. */
export interface KbArticle {
  /** meta description 의 제목. slug 는 40자에서 잘려 있어 이쪽을 쓴다. */
  readonly title: string;
  /** product-chip 원문. 우리 제품인지 판정하는 유일하게 믿을 수 있는 정보다. */
  readonly products: readonly string[];
  readonly published: string;
  readonly modified: string;
  /** 본문 섹션. 제목(Issue/Introduction 등) → 본문. */
  readonly sections: ReadonlyMap<string, string>;
}

/**
 * 우리 환경에 걸리는 제품 태그.
 *
 * slug 키워드로 거르면 안 된다 — 실제로 걸러보니 staff-tasks 가 "-tas" 로,
 * recompute-datastore 가 "tas" 로 걸렸다. 경계를 고쳐도 제목에 제품명이 없는 문서를
 * 놓치는 반대 문제가 남는다. product-chip 은 Broadcom 이 붙인 정규 제품명이라
 * 부분 일치로 봐도 오탐이 나지 않는다.
 *
 * 값은 표본 59건에서 실제로 관측된 태그를 기준으로 맞췄다:
 *   VMware Tanzu Platform - Cloud Foundry / VMware Tanzu Platform Core /
 *   VMware Tanzu RabbitMQ / RabbitMQ / VMware Tanzu Data Suite
 */
export const WATCH_PRODUCTS: ReadonlyArray<{
  readonly re: RegExp;
  readonly product: string;
  /** 여러 제품을 싸잡는 태그인가. 이것만 걸린 문서는 제외 태그에 밀린다. */
  readonly umbrella?: boolean;
}> = [
  // 위에서부터 먼저 맞는 것 하나만 고른다. 좁은 이름을 위에 둔다.
  { re: /cloud foundry/i, product: "TAS / Cloud Foundry" },
  { re: /gemfire/i, product: "GemFire" },
  { re: /spring cloud gateway/i, product: "Spring Cloud Gateway" },
  { re: /credhub/i, product: "CredHub" },
  { re: /healthwatch/i, product: "Healthwatch" },
  { re: /rabbitmq/i, product: "RabbitMQ" },
  { re: /ops(erations)? manager/i, product: "Ops Manager" },
  { re: /\bbosh\b/i, product: "BOSH" },
  { re: /tanzu (application service|platform|hub)/i, product: "Tanzu Platform" },
  // "VMware Tanzu Data Suite" 는 GemFire·Greenplum·Postgres 를 한데 묶은 태그다.
  // GemFire 문서가 이 태그만 달고 오는 경우가 있어 버리지 않되, 우산이라고 표시해 둔다.
  { re: /tanzu data suite/i, product: "Tanzu Data Suite", umbrella: true },
];

/**
 * 이 태그가 붙으면 우리 것이 아니다.
 *
 * 우산 태그에만 걸린 문서를 떨어뜨리는 데 쓴다. 실측에서 Greenplum 문서가
 * "VMware Tanzu Data Suite" 를 함께 달고 와 GemFire 로 잡혔다.
 */
export const EXCLUDE_CHIPS: readonly RegExp[] = [/greenplum/i];

/** 우리가 챙기는 본문 섹션. 이 순서로 화면과 프롬프트에 싣는다. */
export const KB_SECTIONS = ["Issue/Introduction", "Environment", "Cause", "Resolution"] as const;

const ENTITIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&nbsp;/g, " "],
  [/&amp;/g, "&"],
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&quot;/g, '"'],
  [/&#0*39;|&#x0*27;|&apos;/gi, "'"],
];

/** HTML 엔티티를 되돌린다. 숫자 참조는 흔한 것만 본다. */
export function decodeEntities(text: string): string {
  let out = text;
  for (const [re, to] of ENTITIES) out = out.replace(re, to);
  return out.replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));
}

/** 태그를 걷어내고 읽을 수 있는 줄글로 만든다. 줄바꿈 구조는 살린다. */
export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** sitemap.xml(인덱스)에서 자식 사이트맵 주소를 순서대로 뽑는다. */
export function parseSitemapIndex(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1] ?? "");
}

/** URL 에서 문서 id 와 slug 를 뽑는다. 형식이 다르면 null. */
export function parseArticleUrl(url: string): { id: number; slug: string } | null {
  const m = /\/external\/article\/(\d+)\/([^/?#]*?)(?:\.html)?(?:[?#].*)?$/.exec(url);
  if (m === null) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? { id, slug: m[2] ?? "" } : null;
}

/** 자식 사이트맵에서 문서 목록을 뽑는다. 문서가 아닌 주소는 버린다. */
export function parseSitemap(xml: string): KbEntry[] {
  const out: KbEntry[] = [];
  for (const block of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const body = block[1] ?? "";
    const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/.exec(body)?.[1] ?? "";
    const parsed = parseArticleUrl(loc);
    if (parsed === null) continue;
    out.push({
      id: parsed.id,
      slug: parsed.slug,
      url: loc,
      lastmod: (/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/.exec(body)?.[1] ?? "").trim(),
    });
  }
  return out;
}

/**
 * from 위치에서 시작하는 div 의 안쪽을 돌려준다.
 *
 * 정규식 하나로 `<div ...>(.*?)</div>` 를 잡으면 안쪽에 div 가 있는 문서(표·목록)에서
 * 첫 번째 닫는 태그에 걸려 본문이 잘린다. 깊이를 세어 짝을 맞춘다.
 */
export function sliceBalancedDiv(html: string, from: number): string {
  const open = html.indexOf(">", from);
  if (open === -1) return "";
  let depth = 1;
  let at = open + 1;
  const start = at;
  while (at < html.length && depth > 0) {
    const next = html.slice(at).search(/<\/?div\b/i);
    if (next === -1) return html.slice(start);
    at += next;
    depth += html.startsWith("</", at) ? -1 : 1;
    at += 4;
  }
  // at 은 마지막으로 만난 태그의 `<` 에서 4 만큼 앞서 있다. 그 `<` 앞까지가 안쪽이다.
  return html.slice(start, Math.max(start, at - 4));
}

/** product-chip 을 전부 뽑는다. 중복은 없앤다. */
export function parseChips(html: string): string[] {
  const seen = new Set<string>();
  for (const m of html.matchAll(/class="product-chip"[^>]*>([\s\S]*?)<\/span>/g)) {
    const chip = stripHtml(m[1] ?? "");
    if (chip !== "") seen.add(chip);
  }
  return [...seen];
}

/** 본문 섹션을 제목 → 본문으로 뽑는다. */
export function parseSections(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const header = /<div[^>]*class="[^"]*article-detail-card-header[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  for (const m of html.matchAll(header)) {
    const name = stripHtml(m[1] ?? "");
    if (name === "") continue;
    const after = (m.index ?? 0) + m[0].length;
    const contentAt = html.indexOf("article-detail-card-content", after);
    if (contentAt === -1) continue;
    // 다음 카드의 머리말보다 뒤에 있으면 이 카드의 본문이 아니다.
    const nextHeader = html.indexOf("article-detail-card-header", after);
    if (nextHeader !== -1 && nextHeader < contentAt) continue;
    const body = stripHtml(sliceBalancedDiv(html, html.lastIndexOf("<div", contentAt)));
    if (body !== "") out.set(name, body);
  }
  return out;
}

/** 문서 HTML 에서 필요한 것만 뽑는다. */
export function parseArticle(html: string): KbArticle {
  const meta = /<meta\s+name="description"\s+content="([^"]*)"/i.exec(html)?.[1] ?? "";
  const headline = /"headline"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(html)?.[1] ?? "";
  return {
    title: decodeEntities(meta !== "" ? meta : headline.replace(/\\"/g, '"')).trim(),
    products: parseChips(html),
    published: (/"datePublished"\s*:\s*"([^"]*)"/.exec(html)?.[1] ?? "").trim(),
    modified: (/"dateModified"\s*:\s*"([^"]*)"/.exec(html)?.[1] ?? "").trim(),
    sections: parseSections(html),
  };
}

/**
 * 제품 태그가 우리 환경에 걸리는지. 걸리는 제품 이름들을 돌려준다(없으면 빈 배열).
 * 이 판정이 비면 LLM 을 부르지 않는다 — 하루 300건을 몇 건으로 줄이는 지점이다.
 */
export function matchProducts(chips: readonly string[]): string[] {
  const hit = new Set<string>();
  let specific = false;
  for (const chip of chips) {
    // 태그 하나당 제품 하나. "VMware Tanzu Platform - Cloud Foundry" 가 두 줄로
    // 잡히지 않게 먼저 맞는 규칙에서 멈춘다.
    const rule = WATCH_PRODUCTS.find(({ re }) => re.test(chip));
    if (rule === undefined) continue;
    hit.add(rule.product);
    if (rule.umbrella !== true) specific = true;
  }
  // 우산 태그에만 걸렸는데 제외 태그가 함께 붙어 있으면 우리 것이 아니다.
  if (!specific && chips.some((chip) => EXCLUDE_CHIPS.some((re) => re.test(chip)))) return [];
  return [...hit];
}

/** 문서에서 "무슨 문제인지" 에 해당하는 줄. 목록에 한 줄로 보여준다. */
export function issueLine(sections: ReadonlyMap<string, string>): string {
  const issue = sections.get("Issue/Introduction") ?? sections.get("Symptoms") ?? "";
  const first = issue.split("\n").find((l) => l.trim() !== "") ?? "";
  return first.trim();
}
