/**
 * 받아둔 기술문서가 우리 환경에 걸리는지 판정한다.
 *
 * 수집과 나눠 둔다. 판정은 LLM 을 부르므로 실패·한도에 걸릴 수 있는데, 그것 때문에
 * 수집이 멈추면 안 된다(CVE 수집/번역을 나눠 둔 것과 같은 이유).
 *
 * 제품 태그로 이미 걸러진 것만 본다 — matched 가 빈 문서는 LLM 을 부르지 않는다.
 * 아직 판정이 없는 것만 처리하므로 반복 실행해도 낭비가 없다.
 *
 *   npm run judge:kb                 한 회차 20건
 *   npm run judge:kb -- --max 100    100건
 */
import { loadEnv } from "../lib/env.ts";
loadEnv();

import { chat, hasOpenAi } from "../lib/aiChat.ts";
import { listKbUnjudged, openDb, setKbVerdict, type KbArticleRow } from "../lib/db.ts";
import { KB_SECTIONS } from "../lib/kb.ts";
import {
  RELEVANCE_SYSTEM_PROMPT,
  VERDICT_LABEL,
  buildRelevanceUser,
  parseVerdict,
} from "../lib/kbPrompt.ts";

const DEFAULT_MAX = 20;
const GAP_MS = 1500;
/** 한 건에 허용하는 시간. 내부 LLM 이 느릴 때를 감안한다. */
const TIMEOUT_MS = 90_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function numArg(name: string, fallback: number): number {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = Number(process.argv[at + 1]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** DB 한 행을 프롬프트가 받는 형태로 되돌린다. */
export function toArticle(row: KbArticleRow): {
  title: string;
  products: string[];
  sections: Map<string, string>;
} {
  const sections = new Map<string, string>();
  const bodies: Record<(typeof KB_SECTIONS)[number], string> = {
    "Issue/Introduction": row.issue,
    Environment: row.environment,
    Cause: row.cause,
    Resolution: row.resolution,
  };
  for (const name of KB_SECTIONS) {
    if (bodies[name].trim() !== "") sections.set(name, bodies[name]);
  }
  return {
    title: row.title,
    products: row.products.split("\n").filter((p) => p !== ""),
    sections,
  };
}

async function main(): Promise<void> {
  if (!(await hasOpenAi())) {
    console.error("LLM 연결이 없습니다. 설정 > LLM 연결에서 붙이거나 OPENAI_API_KEY 를 넣어주세요.");
    process.exitCode = 1;
    return;
  }

  const max = numArg("max", DEFAULT_MAX);
  const db = await openDb();
  let done = 0;
  let failed = 0;

  try {
    const rows = await listKbUnjudged(db, max);
    console.log(`환경 적합성 판정 — 대상 ${rows.length}건`);
    if (rows.length === 0) {
      console.log("판정할 문서가 없습니다. `npm run collect:kb` 로 먼저 모아주세요.");
      return;
    }
    console.log("");

    for (const row of rows) {
      try {
        const answer = await chat(
          RELEVANCE_SYSTEM_PROMPT,
          buildRelevanceUser(toArticle(row)),
          { timeoutMs: TIMEOUT_MS },
        );
        const { verdict, why } = parseVerdict(answer);
        await setKbVerdict(db, row.article_id, verdict, why);
        done += 1;
        console.log(`  ${row.article_id}  ${VERDICT_LABEL[verdict]}  ${why.slice(0, 60)}`);
      } catch (error) {
        // 한 건이 막혀도 나머지는 계속한다. 판정이 없는 채로 남아 다음 회차에 다시 잡힌다.
        failed += 1;
        console.log(`  ${row.article_id}  실패 — ${String(error instanceof Error ? error.message : error).slice(0, 70)}`);
      }
      await sleep(GAP_MS);
    }
  } finally {
    await db.close();
  }

  console.log("");
  console.log(`판정 ${done}건` + (failed > 0 ? ` · 실패 ${failed}건 (다시 실행하면 이어서 합니다)` : ""));
}

if (process.argv[1]?.includes("judge-kb") === true) {
  main().catch((error: unknown) => {
    console.error("환경 적합성 판정 실패:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
