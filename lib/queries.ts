/**
 * 뷰어 전용 조회 쿼리. 읽기만 한다.
 *
 * 뷰어는 포털에 절대 접속하지 않는다. 화면을 몇 번 새로고침하든
 * Broadcom 쪽 트래픽은 0이다.
 */
import { openDb, type Db } from "./db.ts";

export interface CaseListRow {
  request_id: number;
  request_id_formatted: string;
  subject: string;
  status: string;
  priority: string;
  category: string;
  party_name: string;
  created_on: string;
  created_on_ms: number | null;
  last_updated: string;
  last_updated_ms: number | null;
  thread_count: number;
  reply_count: number;
  /** 마지막 글이 우리 것인가. 0이면 상대 답변 = 우리가 답할 차례 */
  latest_is_ours: number | null;
  latest_author: string | null;
  latest_at: string | null;
  /** 아직 확인하지 않은 상대 답변 수 */
  unread_replies: number;
  description_text: string;
  description_html: string;
  case_version: number | null;
  team_id: string;
}

export interface ThreadViewRow {
  thread_id: number;
  author_unit: string;
  is_ours: number;
  res_date_ms: number | null;
  res_date_val: string;
  body_text: string;
}

/**
 * teamId 로 좁힐 때 쓸 WHERE 절. 기존 뷰어(팀 무관 전체 조회)가 안 깨지도록
 * teamId 를 안 주면 빈 문자열이라 전체를 그대로 조회한다.
 */
function caseListSql(whereClause: string): string {
  return `
SELECT
  c.request_id, c.request_id_formatted, c.subject, c.status, c.priority,
  c.category, c.party_name, c.created_on, c.created_on_ms, c.last_updated, c.last_updated_ms,
  c.description_text, c.description_html, c.case_version, c.team_id,
  (SELECT COUNT(*) FROM threads t WHERE t.request_id = c.request_id) AS thread_count,
  (SELECT COUNT(*) FROM threads t WHERE t.request_id = c.request_id AND t.is_ours = 0) AS reply_count,
  (SELECT t.is_ours     FROM threads t WHERE t.request_id = c.request_id ORDER BY t.res_date_ms DESC LIMIT 1) AS latest_is_ours,
  (SELECT t.author_unit FROM threads t WHERE t.request_id = c.request_id ORDER BY t.res_date_ms DESC LIMIT 1) AS latest_author,
  (SELECT t.res_date_val FROM threads t WHERE t.request_id = c.request_id ORDER BY t.res_date_ms DESC LIMIT 1) AS latest_at,
  (SELECT COUNT(*) FROM threads t
    WHERE t.request_id = c.request_id AND t.is_ours = 0
      AND COALESCE(t.res_date_ms, 0) >
          COALESCE((SELECT r.last_read_thread_ms FROM case_reads r WHERE r.request_id = c.request_id), 0)
  ) AS unread_replies
FROM cases c
${whereClause}
ORDER BY c.last_updated_ms DESC, c.request_id DESC
`;
}

const CASE_LIST_SQL = caseListSql("");

/** 조회 결과를 프로토타입 없는 객체 대신 평범한 객체로 바꾼다(Next.js 직렬화 대비). */
function toPlain<T>(rows: unknown[]): T[] {
  return rows.map((row) => ({ ...(row as object) })) as T[];
}

/** DB 를 열고 콜백 실행 후 반드시 닫는다. dbFile 은 테스트에서 임시 DB 용. */
async function withDb<T>(run: (db: Db) => Promise<T>, dbFile?: string): Promise<T> {
  const db = dbFile ? await openDb(dbFile) : await openDb();
  try {
    return await run(db);
  } finally {
    await db.close();
  }
}

/** MCP 등 팀 단위 조회가 공통으로 쓰는 옵션. teamId 를 생략하면 기존처럼 전체를 본다. */
export interface TeamScopedQueryOptions {
  teamId?: string;
  /** 테스트에서 임시 DB 를 가리키기 위한 것. 실제 호출부는 생략한다. */
  dbFile?: string;
}

/** 포털 상태 문자열로 종료 여부를 판정한다. */
export function isClosedStatus(status: string): boolean {
  const s = status.toLowerCase();
  return s.includes("closed") || s.includes("resolved") || s.includes("cancel");
}

/**
 * teamId 를 생략하면(기존 뷰어 호출) 팀 무관 전체 케이스를 그대로 돌려준다.
 * MCP 읽기 도구처럼 teamId 를 주면 그 팀 소유 케이스로만 좁혀진다.
 */
export function listCases(options: TeamScopedQueryOptions = {}): Promise<CaseListRow[]> {
  const { teamId, dbFile } = options;
  return withDb(async (db) => {
    const sql = teamId ? caseListSql("WHERE c.team_id = ?") : CASE_LIST_SQL;
    const rows = teamId ? await db.all(sql, [teamId]) : await db.all(sql);
    return toPlain<CaseListRow>(rows);
  }, dbFile);
}

/** 진행중 / 종료 케이스를 나눠서 돌려준다. */
export async function listCasesSplit(
  options: TeamScopedQueryOptions = {},
): Promise<{ open: CaseListRow[]; closed: CaseListRow[] }> {
  const all = await listCases(options);
  return {
    open: all.filter((c) => !isClosedStatus(c.status)),
    closed: all.filter((c) => isClosedStatus(c.status)),
  };
}

/**
 * teamId 를 주면 그 팀 소유가 아닌 케이스는 null(못 찾음과 동일)로 취급한다 —
 * MCP 도구가 다른 팀 케이스를 들여다보지 못하게 막는 경계다.
 */
export function getCase(requestId: number, options: TeamScopedQueryOptions = {}): Promise<CaseListRow | null> {
  const { teamId, dbFile } = options;
  return withDb(async (db) => {
    // 서브쿼리를 FROM 에 둘 때 Postgres 는 별칭(AS q)을 요구한다.
    const sql = teamId
      ? `SELECT * FROM (${caseListSql("WHERE c.team_id = ?")}) AS q WHERE request_id = ?`
      : `SELECT * FROM (${CASE_LIST_SQL}) AS q WHERE request_id = ?`;
    const rows = teamId
      ? await db.all(sql, [teamId, requestId])
      : await db.all(sql, [requestId]);
    return toPlain<CaseListRow>(rows)[0] ?? null;
  }, dbFile);
}

export function listThreads(requestId: number, dbFile?: string): Promise<ThreadViewRow[]> {
  return withDb(
    async (db) =>
      toPlain<ThreadViewRow>(
        await db.all(
          `SELECT thread_id, author_unit, is_ours, res_date_ms, res_date_val, body_text
           FROM threads WHERE request_id = ?
           ORDER BY res_date_ms ASC, thread_id ASC`,
          [requestId],
        ),
      ),
    dbFile,
  );
}

export interface LastRunSummary {
  status: string;
  started_at: string;
  error: string | null;
}

/** 목록 화면 상단에 수집 신선도를 띄우기 위한 최소 정보. */
export function getLastRun(): Promise<LastRunSummary | null> {
  return withDb(async (db) => {
    const rows = toPlain<LastRunSummary>(
      await db.all("SELECT status, started_at, error FROM runs ORDER BY run_id DESC LIMIT 1"),
    );
    return rows[0] ?? null;
  });
}

/** 케이스를 열었을 때 해당 시점까지 확인한 것으로 표시한다. */
export function markCaseRead(requestId: number): Promise<void> {
  return withDb(async (db) => {
    const rows = (await db.all(
      "SELECT COALESCE(MAX(res_date_ms), 0) AS m FROM threads WHERE request_id = ?",
      [requestId],
    )) as Array<{ m: number }>;
    const latest = rows[0]?.m ?? 0;
    // 두 값 중 큰 쪽 유지: SQLite 는 스칼라 MAX(a,b), Postgres 는 GREATEST(a,b).
    const greater = db.dialect === "postgres" ? "GREATEST" : "MAX";
    await db.run(
      `INSERT INTO case_reads (request_id, last_read_thread_ms, read_at) VALUES (?, ?, ?)
       ON CONFLICT(request_id) DO UPDATE SET
         last_read_thread_ms = ${greater}(case_reads.last_read_thread_ms, excluded.last_read_thread_ms),
         read_at = excluded.read_at`,
      [requestId, latest, new Date().toISOString()],
    );
  });
}

export interface AttachmentViewRow {
  document_id: number;
  thread_id: number | null;
  doc_name: string;
  doc_path: string;
  content_type: string;
  file_size: number;
  uploaded_by: string;
  uploaded_at: string;
  uploaded_ms: number | null;
}

/** 다운로드 프록시가 쓰는, 첨부 하나의 원본 정보. */
export interface AttachmentSourceRow {
  document_id: number;
  request_id: number;
  doc_name: string;
  doc_path: string;
  content_type: string;
}

/** document_id 로 첨부 하나를 찾는다. 없으면 null. */
export function getAttachment(
  documentId: number,
  dbFile?: string,
): Promise<AttachmentSourceRow | null> {
  return withDb(async (db) => {
    const rows = toPlain<AttachmentSourceRow>(
      await db.all(
        `SELECT document_id, request_id, doc_name, doc_path, content_type
           FROM attachments WHERE document_id = ? LIMIT 1`,
        [documentId],
      ),
    );
    return rows[0] ?? null;
  }, dbFile);
}

export function listAttachments(requestId: number, dbFile?: string): Promise<AttachmentViewRow[]> {
  return withDb(
    async (db) =>
      toPlain<AttachmentViewRow>(
        await db.all(
          `SELECT document_id, thread_id, doc_name, doc_path, content_type,
                  file_size, uploaded_by, uploaded_at, uploaded_ms
           FROM attachments WHERE request_id = ?
           ORDER BY uploaded_ms ASC, document_id ASC`,
          [requestId],
        ),
      ),
    dbFile,
  );
}

/** 사이드바에 쓰는 건수. 매 페이지 렌더마다 호출되므로 가볍게 센다. */
export function countsForNav(): Promise<{
  open: number; closed: number; unread: number; cves: number; criticalCves: number;
}> {
  return withDb(async (db) => {
    const rows = (await db.all(
      `SELECT c.status AS status,
              (SELECT COUNT(*) FROM threads t
                WHERE t.request_id = c.request_id AND t.is_ours = 0
                  AND COALESCE(t.res_date_ms, 0) >
                      COALESCE((SELECT r.last_read_thread_ms FROM case_reads r
                                 WHERE r.request_id = c.request_id), 0)) AS unread
       FROM cases c`,
    )) as Array<{ status: string; unread: number }>;

    let open = 0;
    let closed = 0;
    let unread = 0;
    for (const row of rows) {
      if (isClosedStatus(row.status)) closed += 1;
      else {
        open += 1;
        if (Number(row.unread) > 0) unread += 1;
      }
    }
    const cveRows = (await db.all("SELECT severity FROM cves")) as Array<{ severity: string }>;
    const criticalCves = cveRows.filter((r) => r.severity === "CRITICAL").length;

    return { open, closed, unread, cves: cveRows.length, criticalCves };
  });
}

/** 정리본이 작성된 케이스 수. */
export function countSummaries(): Promise<number> {
  return withDb(async (db) => {
    const rows = (await db.all(
      "SELECT COUNT(DISTINCT request_id) AS c FROM case_summaries",
    )) as Array<{ c: number }>;
    return Number(rows[0]?.c ?? 0);
  });
}

/** 기존 케이스에서 고객사·제품 같은 목록을 뽑는다. 작성 폼의 선택지로 쓴다. */
export function listDistinct(column: "party_name" | "category"): Promise<string[]> {
  return withDb(async (db) => {
    const rows = (await db.all(
      `SELECT ${column} AS v, COUNT(*) AS c FROM cases
        WHERE ${column} <> '' GROUP BY ${column} ORDER BY c DESC LIMIT 40`,
    )) as Array<{ v: string }>;
    return rows.map((r) => r.v);
  });
}

export interface CveViewRow {
  cve_id: string;
  product: string;
  severity: string;
  score: number | null;
  published: string;
  modified: string;
  summary: string;
  url: string;
  first_seen: string;
  dismissed: number;
  summary_ko: string;
}

export function listCves(): Promise<CveViewRow[]> {
  return withDb(async (db) =>
    toPlain<CveViewRow>(
      await db.all(
        `SELECT cve_id, product, severity, score, published, modified,
                summary, summary_ko, url, first_seen, dismissed
           FROM cves
          ORDER BY published DESC, cve_id DESC
          LIMIT 400`,
      ),
    ),
  );
}

export interface CveDetailRow extends CveViewRow {
  keyword: string;
  vector: string;
  attack_vector: string;
  attack_complexity: string;
  privileges_required: string;
  user_interaction: string;
  impact_c: string;
  impact_i: string;
  impact_a: string;
  cwe: string;
  references_json: string;
  affected_json: string;
}

/** 같은 CVE 가 여러 제품에 걸릴 수 있으므로 전부 돌려준다. */
export function getCve(cveId: string): Promise<CveDetailRow[]> {
  return withDb(async (db) =>
    toPlain<CveDetailRow>(
      await db.all("SELECT * FROM cves WHERE cve_id = ? ORDER BY product", [cveId]),
    ),
  );
}

export interface MonthCaseRow {
  request_id: number;
  request_id_formatted: string;
  subject: string;
  status: string;
  priority: string;
  category: string;
  party_name: string;
  created_on: string;
  created_on_ms: number | null;
  last_updated: string;
  /** 마지막 Broadcom 답변. 보고서의 "진행 현황" 칸에 쓴다. */
  last_reply: string;
}

/**
 * 해당 월에 등록된 케이스. 정기점검 보고서의 SR 섹션 후보다.
 * 보고서는 "그 달에 발생한 SR" 기준이라 생성일로 자른다. month 는 'YYYY-MM'.
 */
export function listCasesInMonth(month: string): Promise<MonthCaseRow[]> {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const start = new Date(y, m - 1, 1).getTime();
  const end = new Date(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1).getTime();

  return withDb(async (db) =>
    toPlain<MonthCaseRow>(
      await db.all(
        `SELECT c.request_id, c.request_id_formatted, c.subject, c.status, c.priority,
                c.category, c.party_name, c.created_on, c.created_on_ms, c.last_updated,
                COALESCE((SELECT t.body_text FROM threads t
                           WHERE t.request_id = c.request_id AND t.is_ours = 0
                           ORDER BY t.res_date_ms DESC LIMIT 1), '') AS last_reply
           FROM cases c
          WHERE c.created_on_ms >= ? AND c.created_on_ms < ?
          ORDER BY c.created_on_ms ASC`,
        [start, end],
      ),
    ),
  );
}

export interface ProductComponent {
  productId: number;
  productName: string;
  componentId: number;
  componentName: string;
  used: number;
}

/**
 * 지금까지 올린 케이스에서 실제로 쓰인 Product · Component 조합.
 * 선택지 목록을 포털에서 못 받아서, 써 본 것만 고를 수 있게 한다.
 */
export function listProductComponents(): Promise<ProductComponent[]> {
  return withDb(async (db) =>
    toPlain<ProductComponent>(
      await db.all(
        `SELECT product_id AS productId, product_name AS productName,
                component_id AS componentId, component_name AS componentName,
                COUNT(*) AS used
           FROM cases
          WHERE product_id IS NOT NULL AND product_name <> ''
            AND component_id IS NOT NULL AND component_name <> ''
          GROUP BY product_id, component_id, product_name, component_name
          ORDER BY productName, used DESC`,
      ),
    ),
  );
}
