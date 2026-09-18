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
import { chat } from "./ai.ts";
import {
  CONFLUENCE_SECTIONS,
  CONFLUENCE_USER_PREFIX,
  SECTION_TIMEOUT_MS,
  type ConfluenceSection,
  assembleConfluenceDoc,
  buildDocTitle,
  buildMetaTable,
  firstLine,
  parseMeta,
  sectionSystemPrompt,
} from "./summaryPrompt.ts";
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

async function readCached(requestId: number, kind: SummaryKind): Promise<Summary | null> {
  const db = await openDb();
  try {
    const rows = (await db.all(
      "SELECT content, source, generated_at FROM case_summaries WHERE request_id = ? AND kind = ?",
      [requestId, kind],
    )) as Array<{ content: string; source: string; generated_at: string }>;
    const row = rows[0];
    if (row === undefined) return null;
    return {
      content: row.content,
      source: row.source === "ai" ? "ai" : "draft",
      generatedAt: row.generated_at,
      cached: true,
    };
  } finally {
    await db.close();
  }
}

async function writeCached(requestId: number, kind: SummaryKind, summary: Summary): Promise<void> {
  const db = await openDb();
  try {
    await db.run(
      `INSERT INTO case_summaries (request_id, kind, content, source, generated_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(request_id, kind) DO UPDATE SET
         content = excluded.content,
         source = excluded.source,
         generated_at = excluded.generated_at`,
      [requestId, kind, summary.content, summary.source, summary.generatedAt],
    );
  } finally {
    await db.close();
  }
}

function sectionById(id: string): ConfluenceSection {
  const found = CONFLUENCE_SECTIONS.find((s) => s.id === id);
  if (found === undefined) throw new Error(`알 수 없는 섹션: ${id}`);
  return found;
}

/**
 * 섹션 하나를 쓴다.
 *
 * 이미 쓴 앞 섹션을 함께 넘겨 같은 말을 되풀이하거나 앞뒤가 어긋나지 않게 한다.
 * temperature 0 — 설정값(기본 0.1)이 먹으면 원문에 없는 문장이 섞인다.
 */
function writeSection(
  section: ConfluenceSection,
  source: string,
  written: ReadonlyArray<{ section: ConfluenceSection; text: string }>,
): Promise<string> {
  const context = written
    .filter((w) => w.text.trim() !== "")
    .map((w) => `[${w.section.heading || "제목과 환경 표"}]\n${w.text}`)
    .join("\n\n");
  const user = context === ""
    ? CONFLUENCE_USER_PREFIX + source
    : `${CONFLUENCE_USER_PREFIX}${source}\n\n=== 이미 작성된 앞 섹션 (되풀이하지 말 것) ===\n${context}`;

  // maxTokens 를 넘기지 않는 것은 의도다 — summaryPrompt.ts 의 설명 참고.
  return chat(sectionSystemPrompt(section), user, {
    temperature: 0,
    timeoutMs: SECTION_TIMEOUT_MS,
  });
}

/**
 * 섹션마다 따로 부르고 코드가 조립한다. 한 번에 시키면 출력 상한에서 잘린다.
 *
 * 제목·환경 표와 문제 정의는 서로 독립이라 같이 보낸다. 원인은 문제 정의를, 해결 방법은
 * 원인을, 최종 결과는 앞 둘을 받아야 말이 이어지므로 순서대로 부른다.
 */
async function composeSections(
  source: string,
  detail: { request_id_formatted: string; status: string; created_on: string; last_updated: string; priority: string },
): Promise<string> {
  const title = sectionById("title");
  const meta = sectionById("meta");
  const problem = sectionById("problem");

  // 제목·표값·문제는 서로 독립이라 같이 보낸다.
  const [titleText, metaText, problemText] = await Promise.all([
    writeSection(title, source, []),
    writeSection(meta, source, []),
    writeSection(problem, source, []),
  ]);

  const written = [{ section: problem, text: problemText }];
  // 진단 → 원인 → 조치는 앞 내용을 받아야 말이 이어진다.
  for (const id of ["diagnosis", "cause", "solution"]) {
    const section = sectionById(id);
    written.push({ section, text: await writeSection(section, source, written) });
  }

  return assembleConfluenceDoc({
    title: buildDocTitle(detail.request_id_formatted, firstLine(titleText), detail.status),
    // 일시와 심각도는 DB 값이다. 모델이 지어낼 자리를 두지 않는다.
    table: buildMetaTable({
      openedRaw: detail.created_on,
      closedRaw: detail.last_updated,
      status: detail.status,
      priority: detail.priority,
      meta: parseMeta(metaText),
    }),
    sections: written,
  });
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
    const cached = await readCached(requestId, kind);
    if (cached !== null) return cached;
  }

  const detail = await getCase(requestId);
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
    threads: (await listThreads(requestId)).map((t) => ({
      isOurs: t.is_ours === 1,
      at: t.res_date_val,
      // 중복 판정의 시간창에 쓴다. 없으면 같은 답변이 두 번 들어간다.
      atMs: t.res_date_ms ?? undefined,
      body: t.body_text,
    })),
  });

  const content = await composeSections(source, detail);
  const summary: Summary = {
    content,
    source: "ai",
    generatedAt: isoNow(),
    cached: false,
  };
  await writeCached(requestId, kind, summary);
  return summary;
}
