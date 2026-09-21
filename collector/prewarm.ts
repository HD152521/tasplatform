/**
 * 새로 종료된 SR 의 Confluence 요약을 미리 만들어 둔다.
 *
 * 왜 미리 만드나 — 요약 한 건이 섹션 4왕복이라 실측 60초쯤 걸린다. 화면에서 누르면
 * 기다리면 그만이지만, MCP 로 붙는 쪽은 연결 타임아웃이 60초라 캐시가 없으면 거의
 * 확실히 끊긴다. 미리 만들어 두면 get_summary 가 즉시 돌아온다.
 *
 * 왜 collect.ts 안이 아니라 따로인가 — worker 가 collect.ts 에 5분 watchdog 을 걸어
 * 둔다(과거 4시간 hang 이력). 요약 몇 건이면 그 상한을 먹어 치워 수집이 통째로
 * 죽는다. 그래서 진입점을 나누고 각자 자기 타임아웃을 갖는다.
 *
 * 대상은 "앞으로 새로 종료되는 것" 뿐이다. 처음 돌 때 워터마크를 지금 시각으로 박고
 * 그 이전에 이미 끝나 있던 건(처음 재 봤을 때 287건)은 영영 건드리지 않는다. 다섯 시간
 * 치 LLM 호출을 아무도 시키지 않았는데 시작하는 일이 없도록.
 *
 * 워터마크는 올리지 않는다. "요약 행이 없다" 는 조건이 이미 처리 완료를 걸러 주므로,
 * 올리지 않아야 실패한 건이 다음 회차에 다시 시도된다.
 */
import { loadEnv } from "../lib/env.ts";
loadEnv();

import { initAppState } from "../lib/appState.ts";
import { openDb } from "../lib/db.ts";
import { getSummary } from "../lib/summary.ts";

/** 워터마크 키. 이 시각 이후에 종료된 건만 자동 요약 대상이다. */
const WATERMARK_KEY = "summary_prewarm_since_ms";

/** 한 회차에 만들 최대 건수. 건당 약 60초다. */
const MAX_PER_RUN = Number(process.env.SR_PREWARM_MAX ?? 3);

interface Pending {
  request_id: number;
  request_id_formatted: string;
  subject: string;
}

/**
 * 종료됐는데 요약이 없는 케이스. 워터마크 이후에 종료된 것만.
 * 오래된 것부터 — 밀린 것이 계속 뒤로 밀리지 않게.
 */
async function findPending(
  db: Awaited<ReturnType<typeof openDb>>,
  sinceMs: number,
  limit: number,
): Promise<Pending[]> {
  return (await db.all(
    `SELECT c.request_id, c.request_id_formatted, c.subject
       FROM cases c
       LEFT JOIN case_summaries s
         ON s.request_id = c.request_id AND s.kind = 'confluence'
      WHERE s.request_id IS NULL
        AND lower(c.status) IN ('closed', 'resolved')
        AND c.last_updated_ms IS NOT NULL
        AND c.last_updated_ms > ?
      ORDER BY c.last_updated_ms ASC
      LIMIT ?`,
    [sinceMs, limit],
  )) as Pending[];
}

async function main(): Promise<void> {
  const db = await openDb();
  try {
    const now = Date.now();
    const stored = await initAppState(db, WATERMARK_KEY, String(now));
    const sinceMs = Number(stored);
    if (!Number.isFinite(sinceMs)) {
      console.error(`[prewarm] 워터마크가 이상합니다: ${stored}`);
      process.exitCode = 1;
      return;
    }

    if (stored === String(now)) {
      // 첫 실행. 이미 끝나 있던 건은 대상이 아니라는 것을 분명히 남긴다.
      console.log("[prewarm] 워터마크를 지금으로 박았습니다. 이전에 종료된 건은 건너뜁니다.");
      return;
    }

    const pending = await findPending(db, sinceMs, MAX_PER_RUN);
    if (pending.length === 0) {
      console.log("[prewarm] 새로 종료된 미요약 케이스가 없습니다.");
      return;
    }

    console.log(`[prewarm] ${pending.length}건을 요약합니다 (한 회차 상한 ${MAX_PER_RUN}).`);
    for (const row of pending) {
      const label = `${row.request_id_formatted} ${String(row.subject).slice(0, 40)}`;
      const startedMs = Date.now();
      try {
        // force 를 주지 않는다 — 사람이 쓴 초안(source='draft')을 덮으면 안 된다.
        const result = await getSummary(row.request_id, "confluence", false);
        if ("error" in result) {
          console.error(`[prewarm] 실패 ${label} — ${result.error}`);
          continue;
        }
        console.log(`[prewarm] 완료 ${label} — ${result.content.length}자 ${Date.now() - startedMs}ms`);
      } catch (error) {
        // 한 건이 깨져도 나머지는 계속한다. 다음 회차에 다시 시도된다.
        console.error(`[prewarm] 실패 ${label} — ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error("[prewarm] 중단:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
