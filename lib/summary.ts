/**
 * 종료 케이스 → Confluence 문서.
 *
 * 팀에서 쓰는 SR 현행화 양식(제목 → 환경 표 → 네 개 섹션)에 맞춰 정리한다.
 * 프롬프트가 곧 문서 형식이므로 문구를 바꾸면 결과 모양이 바뀐다.
 *
 * 케이스 본문을 외부로 보내므로 OpenAI 만 쓴다 (lib/openai.ts 의 경고 참고).
 * 한 번 만들면 저장해 두고 다시 부르지 않는다 — force 로만 다시 만든다.
 */
import "server-only";
import { openDb } from "./db.ts";
import { isoNow } from "./dates.ts";
import { chat } from "./openai.ts";
import { CONFLUENCE_SYSTEM_PROMPT, CONFLUENCE_USER_PREFIX } from "./summaryPrompt.ts";
import { getCase, listThreads } from "./queries.ts";
import { buildSourceText } from "./srReportFormat.ts";

export type SummaryKind = "confluence";
export type SummarySource = "draft" | "ai";

export interface Summary {
  content: string;
  source: SummarySource;
  generatedAt: string;
  cached: boolean;
}

export const SUMMARY_KINDS: ReadonlyArray<{ id: SummaryKind; label: string; note: string }> = [
  { id: "confluence", label: "Confluence 문서", note: "SR 현행화 양식" },
];

export function isSummaryKind(value: unknown): value is SummaryKind {
  return value === "confluence";
}

function readCached(requestId: number, kind: SummaryKind): Summary | null {
  const db = openDb();
  try {
    const rows = db
      .prepare(
        "SELECT content, source, generated_at FROM case_summaries WHERE request_id = ? AND kind = ?",
      )
      .all(requestId, kind) as unknown as Array<{
        content: string; source: string; generated_at: string;
      }>;
    const row = rows[0];
    if (row === undefined) return null;
    return {
      content: row.content,
      source: row.source === "ai" ? "ai" : "draft",
      generatedAt: row.generated_at,
      cached: true,
    };
  } finally {
    db.close();
  }
}

function writeCached(requestId: number, kind: SummaryKind, summary: Summary): void {
  const db = openDb();
  try {
    db.prepare(
      `INSERT INTO case_summaries (request_id, kind, content, source, generated_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(request_id, kind) DO UPDATE SET
         content = excluded.content,
         source = excluded.source,
         generated_at = excluded.generated_at`,
    ).run(requestId, kind, summary.content, summary.source, summary.generatedAt);
  } finally {
    db.close();
  }
}

/**
 * 문서를 얻는다. 저장된 것이 있으면 그대로, 없으면 만들어 저장한다.
 * force 를 주면 다시 만든다.
 */
export async function getSummary(
  requestId: number,
  kind: SummaryKind,
  force = false,
): Promise<Summary | { error: string }> {
  if (!force) {
    const cached = readCached(requestId, kind);
    if (cached !== null) return cached;
  }

  const detail = getCase(requestId);
  if (detail === null) return { error: "케이스를 찾을 수 없습니다." };

  const source = buildSourceText({
    requestId: detail.request_id_formatted,
    subject: detail.subject,
    status: detail.status,
    priority: detail.priority,
    product: detail.category,
    createdOn: detail.created_on,
    closedOn: detail.last_updated,
    description: detail.description_text,
    threads: listThreads(requestId).map((t) => ({
      isOurs: t.is_ours === 1,
      at: t.res_date_val,
      body: t.body_text,
    })),
  });

  const content = await chat(
    CONFLUENCE_SYSTEM_PROMPT,
    CONFLUENCE_USER_PREFIX + source,
    { maxTokens: 4000 },
  );
  const summary: Summary = {
    content,
    source: "ai",
    generatedAt: isoNow(),
    cached: false,
  };
  writeCached(requestId, kind, summary);
  return summary;
}
