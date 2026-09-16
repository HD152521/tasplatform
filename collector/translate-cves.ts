/**
 * CVE 설명을 한국어로 번역해 저장한다.
 *
 * 아직 번역되지 않은 것만 처리하므로 반복 실행해도 낭비가 없다.
 * 무료 한도(분당 요청 제한)를 지키려 호출 사이에 간격을 둔다.
 *
 *   npm run translate:cve
 */
import { loadEnv } from "../lib/env.ts";
loadEnv();

import { openDb } from "../lib/db.ts";
import { TranslateError, availableProviders, hasTranslator, translateToKorean } from "../lib/translate.ts";

const GAP_MS = 2500;
/** 한 건을 몇 번까지 다시 시도할지. */
const MAX_ATTEMPTS = 3;
/** 서버가 대기 시간을 안 알려줄 때 쓰는 값, 그리고 그 상한. */
const FALLBACK_WAIT_MS = 20_000;
const MAX_WAIT_MS = 90_000;
/** 연달아 이만큼 실패하면 한도가 정말 소진된 것으로 보고 멈춘다. */
const GIVE_UP_AFTER = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 다시 시도해볼 만한 실패인가. 한도(429)와 타임아웃이 그렇다. */
function waitFor(error: unknown): number | null {
  if (error instanceof TranslateError) {
    if (error.status !== 429) return null;
    const hinted = error.retryAfterMs > 0 ? error.retryAfterMs : FALLBACK_WAIT_MS;
    return Math.min(hinted + 1_000, MAX_WAIT_MS);
  }
  // AbortSignal.timeout 이 끊은 경우. 서버가 밀렸을 뿐이라 잠깐 뒤 다시 해본다.
  if (error instanceof Error && error.name === "TimeoutError") return FALLBACK_WAIT_MS;
  return null;
}

async function main(): Promise<void> {
  if (!hasTranslator()) {
    console.error("번역 키가 없습니다. .env 에 GEMINI_API_KEY 또는 GROQ_API_KEY 를 넣어주세요.");
    process.exitCode = 1;
    return;
  }

  const db = openDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT cve_id, summary FROM cves
        WHERE summary_ko = '' AND summary <> ''
        ORDER BY published DESC`,
    )
    .all() as Array<{ cve_id: string; summary: string }>;

  console.log(`제공자: ${availableProviders().join(" → ")}`);
  console.log(`번역 대상 ${rows.length}건`);
  if (rows.length === 0) {
    db.close();
    return;
  }

  let done = 0;
  let failed = 0;
  let streak = 0; // 연속 실패 수

  try {
    for (const row of rows) {
      let saved = false;
      let last: unknown;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !saved; attempt += 1) {
        try {
          const ko = await translateToKorean(row.summary);
          db.prepare("UPDATE cves SET summary_ko = ? WHERE cve_id = ?")
            .run(ko.translation, row.cve_id);
          saved = true;
          console.log(`  ${row.cve_id}  [${ko.provider}] ${ko.translation.slice(0, 54)}`);
        } catch (error) {
          last = error;
          const wait = waitFor(error);
          if (wait === null || attempt === MAX_ATTEMPTS) break;
          // Groq 한도는 분당이라 대개 몇 초면 풀린다. 포기하지 않고 기다린다.
          console.log(`  ${row.cve_id}  한도·지연 — ${Math.round(wait / 1000)}초 기다렸다 재시도`);
          await sleep(wait);
        }
      }

      if (saved) {
        done += 1;
        streak = 0;
      } else {
        failed += 1;
        streak += 1;
        const why = last instanceof TranslateError ? `HTTP ${last.status}` : String(last).slice(0, 60);
        console.log(`  ${row.cve_id}  실패 — ${why}`);
        // 기다려도 연달아 막히면 한도가 정말 소진된 것이다. 그때만 멈춘다.
        if (streak >= GIVE_UP_AFTER) {
          console.log(`  ${GIVE_UP_AFTER}건 연속 실패. 한도가 소진된 것으로 보고 중단합니다.`);
          break;
        }
      }
      await sleep(GAP_MS);
    }
  } finally {
    db.close();
  }

  const left = rows.length - done - failed;
  console.log("");
  console.log(
    `번역 ${done}건`
    + (failed > 0 ? ` · 실패 ${failed}건` : "")
    + (left > 0 ? ` · 남음 ${left}건 (다시 실행하면 이어서 합니다)` : ""),
  );
}

main().catch((error: unknown) => {
  console.error("번역 실패:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
