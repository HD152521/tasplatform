/**
 * SR 상세 슬라이드용 보고서 생성.
 *
 * ⚠ 케이스 본문이 외부로 나가는 경로다. 더 이상 유일하지 않다 —
 *   lib/replySummary.ts 가 새 답변 요약을 만들려고 15분마다 자동으로 같은 곳에 보낸다.
 *   그쪽은 결과가 슬랙 채널에도 실리므로, 뷰어 로그인 권한이 없는 사람까지 본다.
 *   "본문이 어디로 나가는가"를 따질 때 이 파일만 보면 틀린다.
 *   고객사(금융권) 인프라 정보가 들어 있으므로 무료 티어에 보내면 안 된다.
 *   그래서 CVE 번역이 쓰는 lib/translate.ts (Gemini·Groq) 와 분리해 두고,
 *   여기서는 OPENAI_API_KEY 만 쓴다. 이 키를 다른 용도로 돌려쓰지 말 것.
 *
 * 보고서는 한 번에 만들지 않는다. 사내 엔드포인트의 출력 상한(512 토큰)보다 양식대로
 * 쓴 보고서가 길어서, 한 번에 시키면 반드시 잘린다. 단계 구성과 그 근거는
 * lib/srPipeline.ts 머리말에, 단계별 프롬프트는 lib/srCompose.ts 에 있다.
 * 양식 조립은 코드가 하므로(assembleReport) 라벨 문구는 여전히 파싱과 묶여 있다.
 */
import "server-only";
import { openDb } from "./db.ts";
import { chat, hasOpenAi } from "./ai.ts";
import { isoNow } from "./dates.ts";
import { getCase, listThreads } from "./queries.ts";
import { composeSrReport } from "./srCompose.ts";
import { parseSrReport, type SrReport } from "./srReportFormat.ts";

export class SrReportError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`SR 보고서 생성 실패 (HTTP ${status}): ${detail}`.trim());
    this.name = "SrReportError";
    this.status = status;
  }
}

/** 케이스 본문을 보낼 수 있는 키가 있는가. */
export function hasSrReporter(): boolean {
  return (process.env.OPENAI_API_KEY ?? "").trim() !== "";
}

async function readCached(requestId: number): Promise<SrReport | null> {
  const db = await openDb();
  try {
    const rows = (await db.all(
      "SELECT content FROM case_summaries WHERE request_id = ? AND kind = 'ppt'",
      [requestId],
    )) as Array<{ content: string }>;
    const row = rows[0];
    return row === undefined ? null : parseSrReport(row.content);
  } finally {
    await db.close();
  }
}

async function writeCached(requestId: number, raw: string): Promise<void> {
  const db = await openDb();
  try {
    await db.run(
      `INSERT INTO case_summaries (request_id, kind, content, source, generated_at)
       VALUES (?, 'ppt', ?, 'ai', ?)
       ON CONFLICT(request_id, kind) DO UPDATE SET
         content = excluded.content,
         source = excluded.source,
         generated_at = excluded.generated_at`,
      [requestId, raw, isoNow()],
    );
  } finally {
    await db.close();
  }
}

/**
 * 케이스 하나의 보고서를 얻는다.
 * 저장된 것이 있으면 그대로 쓰고, force 를 주면 다시 만든다.
 */
export async function getSrReport(
  requestId: number,
  force = false,
): Promise<SrReport & { cached: boolean }> {
  if (!force) {
    const cached = await readCached(requestId);
    if (cached !== null) return { ...cached, cached: true };
  }
  if (!(await hasOpenAi())) {
    throw new SrReportError(0, "LLM 연결이 설정되지 않았습니다 (설정 > LLM 또는 OPENAI_API_KEY).");
  }

  const detail = await getCase(requestId);
  if (detail === null) throw new SrReportError(404, "케이스를 찾을 수 없습니다.");

  const threads = (await listThreads(requestId)).map((t) => ({
    isOurs: t.is_ours === 1,
    at: t.res_date_val,
    // 중복 판정의 시간창에 쓴다. null 이면 판정을 걸지 않는다.
    atMs: t.res_date_ms ?? undefined,
    body: t.body_text,
  }));

  let raw: string;
  try {
    raw = await composeSrReport(chat, {
      requestId: detail.request_id_formatted,
      subject: detail.subject,
      status: detail.status,
      priority: detail.priority,
      product: detail.category,
      createdOn: detail.created_on,
      closedOn: detail.last_updated,
      description: detail.description_text,
    }, threads);
  } catch (error) {
    // 단계 중 하나가 끝까지 실패하면 보고서를 만들지 않는다. 반쯤 채운 문서를
    // 저장하면 다음에 캐시로 그대로 나간다.
    throw new SrReportError(0, error instanceof Error ? error.message : String(error));
  }

  await writeCached(requestId, raw);
  return { ...parseSrReport(raw), cached: false };
}
