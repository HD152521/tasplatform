/**
 * Broadcom 기술문서를 수집한다.
 *
 * 케이스 수집과 완전히 별개다 — 브라우저도, Broadcom 세션도 쓰지 않는다.
 * 세션이 만료돼 있어도 정상 동작한다(CVE 수집과 같은 성질).
 *
 * 전체 18만 건을 받는 것은 무리라, 사이트맵 **마지막 장(가장 최근 문서)** 부터 본다.
 * 한 회차에 받는 본문 수를 막아두어 반복 실행하면 이어서 훑는다.
 *
 *   npm run collect:kb                 최신 사이트맵 1장, 본문 60건까지
 *   npm run collect:kb -- --max 200    한 회차에 200건까지
 *   npm run collect:kb -- --pages 3    사이트맵 3장(더 과거까지)
 */
import { loadEnv } from "../lib/env.ts";
loadEnv();

import { isoNow } from "../lib/dates.ts";
import { getKbSeen, openDb, upsertKbArticle, type KbSeen } from "../lib/db.ts";
import { KbError, fetchArticleHtml, fetchLatestEntries } from "../lib/kbFetch.ts";
import { issueLine, matchProducts, parseArticle, type KbEntry } from "../lib/kb.ts";

const DEFAULT_MAX = 60;
const DEFAULT_PAGES = 1;
/** 본문 요청 사이 간격. 남의 서버다 — 초당 한 건을 넘기지 않는다. */
const GAP_MS = 900;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** `--max 200` 같은 숫자 인자. 없거나 이상하면 기본값. */
function numArg(name: string, fallback: number): number {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = Number(process.argv[at + 1]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * 본문을 받아야 하는 문서를 고른다. 최신 id 부터.
 *
 *  - 처음 보는 id            → 받는다(신규)
 *  - 봤는데 lastmod 가 바뀜   → 우리 제품일 때만 받는다(개정)
 *  - 우리 제품이 아니었던 것  → 개정돼도 안 받는다. 제품 태그는 이미 캐시돼 있다.
 */
export function pickTargets(
  entries: readonly KbEntry[],
  seen: ReadonlyMap<number, KbSeen>,
  max: number,
): KbEntry[] {
  const out: KbEntry[] = [];
  for (const entry of [...entries].sort((a, b) => b.id - a.id)) {
    const known = seen.get(entry.id);
    if (known === undefined) out.push(entry);
    else if (known.lastmod !== entry.lastmod && known.matched !== "") out.push(entry);
    if (out.length >= max) break;
  }
  return out;
}

async function main(): Promise<void> {
  const max = numArg("max", DEFAULT_MAX);
  const pages = numArg("pages", DEFAULT_PAGES);

  console.log(`기술문서 수집 — 최신 사이트맵 ${pages}장, 본문 최대 ${max}건`);

  let entries;
  try {
    entries = await fetchLatestEntries(pages);
  } catch (error) {
    console.error(`사이트맵을 받지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  사이트맵 ${entries.length}건 (id ${Math.min(...entries.map((e) => e.id))} ~ ${Math.max(...entries.map((e) => e.id))})`);

  const db = await openDb();
  let fresh = 0;
  let ours = 0;
  let failed = 0;
  const found: string[] = [];

  try {
    const targets = pickTargets(entries, await getKbSeen(db), max);
    console.log(`  본문 받을 문서 ${targets.length}건`);
    console.log("");

    for (const entry of targets) {
      let html;
      try {
        html = await fetchArticleHtml(entry.url);
      } catch (error) {
        // 한 건이 막혀도 나머지는 계속한다. 다만 조용히 넘어가지는 않는다.
        failed += 1;
        const why = error instanceof KbError ? `HTTP ${error.status}` : String(error).slice(0, 60);
        console.log(`  ${entry.id}  실패 — ${why}`);
        await sleep(GAP_MS);
        continue;
      }

      const article = parseArticle(html);
      const matched = matchProducts(article.products);
      const isNew = await upsertKbArticle(db, {
        article_id: entry.id,
        slug: entry.slug,
        url: entry.url,
        title: article.title,
        products: article.products.join("\n"),
        matched: matched.join(", "),
        lastmod: entry.lastmod,
        published: article.published,
        modified: article.modified,
        issue: article.sections.get("Issue/Introduction") ?? "",
        environment: article.sections.get("Environment") ?? "",
        cause: article.sections.get("Cause") ?? "",
        resolution: article.sections.get("Resolution") ?? "",
      });

      if (isNew) fresh += 1;
      if (matched.length > 0) {
        ours += 1;
        found.push(`${entry.id}  ${matched.join(", ")}  ${issueLine(article.sections).slice(0, 70)}`);
      }
      await sleep(GAP_MS);
    }
  } finally {
    await db.close();
  }

  console.log("");
  console.log(
    `신규 ${fresh}건 · 우리 제품 ${ours}건`
    + (failed > 0 ? ` · 실패 ${failed}건` : "")
    + `  (${isoNow()})`,
  );
  for (const line of found) console.log(`   ${line}`);
  if (ours > 0) console.log("\n환경 적합성 판정은 `npm run judge:kb` 로 이어서 합니다.");
}

// 테스트에서 import 할 때는 실행하지 않는다(pickTargets 만 쓴다).
if (process.argv[1]?.includes("collect-kb") === true) {
  main().catch((error: unknown) => {
    console.error("기술문서 수집 실패:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
