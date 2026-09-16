/**
 * NVD 에서 보안 취약점을 가져온다.
 *
 * 케이스 수집과 완전히 별개다 — 브라우저도, Broadcom 세션도 쓰지 않는다.
 * 그래서 세션이 만료돼 있어도 이 수집은 정상 동작한다.
 *
 *   npm run collect:cve            최근 90일
 *   npm run collect:cve -- 365     최근 365일
 */
import { loadEnv } from "../lib/env.ts";
loadEnv();

import { isoNow } from "../lib/dates.ts";
import { openDb, upsertCve } from "../lib/db.ts";
import { NvdError, WATCH, fetchCves } from "../lib/nvd.ts";

const DEFAULT_DAYS = 90;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const arg = process.argv.find((a) => /^\d+$/.test(a));
  const days = arg === undefined ? DEFAULT_DAYS : Number(arg);

  const db = openDb();
  let total = 0;
  let fresh = 0;
  let failed = 0;
  const newOnes: string[] = [];

  console.log(`NVD 조회 — 최근 ${days}일, 키워드 ${WATCH.length}개`);
  console.log("");

  try {
    for (const { keyword, product } of WATCH) {
      let rows;
      try {
        rows = await fetchCves(keyword, product, days);
      } catch (error) {
        // 한 키워드가 막혀도 나머지는 계속한다. 다만 조용히 넘어가지는 않는다.
        failed += 1;
        const why = error instanceof NvdError ? `HTTP ${error.status}` : String(error).slice(0, 60);
        console.log(`  ${keyword.padEnd(30)} 실패 — ${why}`);
        await sleep(7000);
        continue;
      }
      let added = 0;
      for (const row of rows) {
        if (upsertCve(db, row)) {
          added += 1;
          if (newOnes.length < 8) {
            newOnes.push(`${row.cve_id}  ${row.severity.padEnd(8)} ${product}`);
          }
        }
      }
      total += rows.length;
      fresh += added;
      console.log(`  ${keyword.padEnd(30)} ${String(rows.length).padStart(3)}건 (신규 ${added})`);
      await sleep(7000); // 키 없이 쓰는 한도(30초 5회) 준수
    }
  } finally {
    db.close();
  }

  console.log("");
  console.log(`조회 ${total}건 · 신규 ${fresh}건` + (failed > 0 ? ` · 실패 ${failed}개 키워드` : "") + `  (${isoNow()})`);
  for (const line of newOnes) console.log(`   ${line}`);
}

main().catch((error: unknown) => {
  console.error("CVE 수집 실패:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
