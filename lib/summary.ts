/**
 * 종료 케이스 정리.
 *
 * 처음 요청하면 만들어서 저장하고, 그 다음부터는 저장분을 돌려준다.
 * 지금은 수집한 내용을 형식에 맞게 엮기만 한다. AI 를 붙이는 자리는
 * generate() 한 곳뿐이라 나중에 그 함수만 바꾸면 된다.
 */
import "server-only";
import { openDb } from "./db.ts";
import { isoNow } from "./dates.ts";
import { getCase, listThreads } from "./queries.ts";

export type SummaryKind = "confluence" | "report";
export type SummarySource = "draft" | "ai";

export interface Summary {
  content: string;
  source: SummarySource;
  generatedAt: string;
  cached: boolean;
}

export const SUMMARY_KINDS: ReadonlyArray<{ id: SummaryKind; label: string; note: string }> = [
  { id: "confluence", label: "Confluence 문서", note: "기술 상세 · 재발 시 검색용" },
  { id: "report", label: "정기 보고서", note: "요약 · 결과 중심" },
];

export function isSummaryKind(value: unknown): value is SummaryKind {
  return value === "confluence" || value === "report";
}

function readCached(requestId: number, kind: SummaryKind): Summary | null {
  const db = openDb();
  try {
    const rows = db
      .prepare(
        "SELECT content, source, generated_at FROM case_summaries WHERE request_id = ? AND kind = ?",
      )
      .all(requestId, kind) as Array<{ content: string; source: string; generated_at: string }>;
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
 * 정리본을 얻는다. 저장된 것이 있으면 그대로, 없으면 만들어 저장한다.
 * force 를 주면 다시 만든다.
 */
export function getSummary(
  requestId: number,
  kind: SummaryKind,
  force = false,
): Summary | { error: string } {
  if (!force) {
    const cached = readCached(requestId, kind);
    if (cached !== null) return cached;
  }

  const detail = getCase(requestId);
  if (detail === null) return { error: "케이스를 찾을 수 없습니다." };

  const threads = listThreads(requestId).map((t) => ({
    isOurs: t.is_ours === 1,
    at: t.res_date_val,
    body: t.body_text,
  }));

  const content = generate(kind, {
    requestIdFormatted: detail.request_id_formatted,
    subject: detail.subject,
    partyName: detail.party_name,
    category: detail.category,
    priority: detail.priority,
    createdOn: detail.created_on,
    lastUpdated: detail.last_updated,
    status: detail.status,
    description: detail.description_text,
    threads,
  });

  const summary: Summary = {
    content,
    source: "draft",
    generatedAt: isoNow(),
    cached: false,
  };
  writeCached(requestId, kind, summary);
  return summary;
}

interface Source {
  requestIdFormatted: string;
  subject: string;
  partyName: string;
  category: string;
  priority: string;
  createdOn: string;
  lastUpdated: string;
  status: string;
  description: string;
  threads: Array<{ isOurs: boolean; at: string; body: string }>;
}

/**
 * 여기가 AI 연동 지점이다.
 * 지금은 수집 내용을 형식에 맞춰 엮기만 한다.
 */
function generate(kind: SummaryKind, s: Source): string {
  return kind === "confluence" ? buildConfluence(s) : buildReport(s);
}

function firstReply(s: Source): string {
  return s.threads.find((t) => !t.isOurs)?.body ?? "";
}

function lastReply(s: Source): string {
  const replies = s.threads.filter((t) => !t.isOurs);
  return replies[replies.length - 1]?.body ?? "";
}

function buildConfluence(s: Source): string {
  const lines: string[] = [];
  lines.push(`h1. [${s.requestIdFormatted}] ${s.subject}`, "");
  lines.push("h2. 기본 정보");
  lines.push(`* 고객사: ${s.partyName}`);
  lines.push(`* 제품/영역: ${s.category}`);
  lines.push(`* 우선순위: ${s.priority}`);
  lines.push(`* 상태: ${s.status}`);
  lines.push(`* 등록: ${s.createdOn}`);
  lines.push(`* 최종: ${s.lastUpdated}`, "");
  lines.push("h2. 문의 내용");
  lines.push(s.description || "(수집된 본문 없음)", "");
  lines.push("h2. 대응 경과");
  for (const t of s.threads) {
    lines.push(`* *${t.isOurs ? "우리" : "Broadcom"}* (${t.at})`);
    for (const line of t.body.split("\n")) {
      if (line.trim() !== "") lines.push(`** ${line.trim()}`);
    }
  }
  lines.push("", "h2. 결론 / 재발 시 확인사항");
  lines.push(lastReply(s) || "(작성 필요)");
  return lines.join("\n");
}

function buildReport(s: Source): string {
  const ours = s.threads.filter((t) => t.isOurs).length;
  const theirs = s.threads.length - ours;
  const lines: string[] = [];
  lines.push(`■ ${s.requestIdFormatted} ${s.subject}`, "");
  lines.push(`- 고객사   : ${s.partyName}`);
  lines.push(`- 영역     : ${s.category} / ${s.priority}`);
  lines.push(`- 기간     : ${s.createdOn} ~ ${s.lastUpdated}`);
  lines.push(`- 상태     : ${s.status}`);
  lines.push(`- 소통 횟수: 총 ${s.threads.length}건 (당사 ${ours} / Broadcom ${theirs})`, "");
  lines.push("[문의 요지]");
  lines.push(trim(s.description, 300) || "(수집된 본문 없음)", "");
  lines.push("[초기 회신]");
  lines.push(trim(firstReply(s), 300) || "(없음)", "");
  lines.push("[최종 결과]");
  lines.push(trim(lastReply(s), 400) || "(작성 필요)");
  return lines.join("\n");
}

function trim(text: string, max: number): string {
  const flat = text.replace(/\n{2,}/g, "\n").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}
