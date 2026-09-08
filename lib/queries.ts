/**
 * 뷰어 전용 조회 쿼리. 읽기만 한다.
 *
 * 뷰어는 포털에 절대 접속하지 않는다. 화면을 몇 번 새로고침하든
 * Broadcom 쪽 트래픽은 0이다.
 */
import { openDb } from "./db.ts";

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
}

export interface ThreadViewRow {
  thread_id: number;
  author_unit: string;
  is_ours: number;
  res_date_ms: number | null;
  res_date_val: string;
  body_text: string;
}

const CASE_LIST_SQL = `
SELECT
  c.request_id, c.request_id_formatted, c.subject, c.status, c.priority,
  c.category, c.party_name, c.created_on, c.created_on_ms, c.last_updated, c.last_updated_ms,
  c.description_text, c.description_html, c.case_version,
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
ORDER BY c.last_updated_ms DESC, c.request_id DESC
`;

/**
 * node:sqlite 는 프로토타입이 없는 객체를 돌려준다.
 * 그대로 클라이언트 컴포넌트로 넘기면 Next.js 가 직렬화를 거부하므로
 * 조회 결과는 반드시 평범한 객체로 바꿔서 내보낸다.
 */
function toPlain<T>(rows: unknown[]): T[] {
  return rows.map((row) => ({ ...(row as object) })) as T[];
}

/** DB를 열고 콜백을 실행한 뒤 반드시 닫는다. */
function withDb<T>(run: (db: ReturnType<typeof openDb>) => T): T {
  const db = openDb();
  try {
    return run(db);
  } finally {
    db.close();
  }
}

/** 포털 상태 문자열로 종료 여부를 판정한다. */
export function isClosedStatus(status: string): boolean {
  const s = status.toLowerCase();
  return s.includes("closed") || s.includes("resolved") || s.includes("cancel");
}

export function listCases(): CaseListRow[] {
  return withDb((db) => toPlain<CaseListRow>(db.prepare(CASE_LIST_SQL).all()));
}

/** 진행중 / 종료 케이스를 나눠서 돌려준다. */
export function listCasesSplit(): { open: CaseListRow[]; closed: CaseListRow[] } {
  const all = listCases();
  return {
    open: all.filter((c) => !isClosedStatus(c.status)),
    closed: all.filter((c) => isClosedStatus(c.status)),
  };
}

export function getCase(requestId: number): CaseListRow | null {
  return withDb((db) => {
    const rows = toPlain<CaseListRow>(
      db.prepare(`SELECT * FROM (${CASE_LIST_SQL}) WHERE request_id = ?`).all(requestId),
    );
    return rows[0] ?? null;
  });
}

export function listThreads(requestId: number): ThreadViewRow[] {
  return withDb((db) =>
    toPlain<ThreadViewRow>(
      db
        .prepare(
          `SELECT thread_id, author_unit, is_ours, res_date_ms, res_date_val, body_text
           FROM threads WHERE request_id = ?
           ORDER BY res_date_ms ASC, thread_id ASC`,
        )
        .all(requestId),
    ),
  );
}

export interface LastRunSummary {
  status: string;
  started_at: string;
  error: string | null;
}

/** 목록 화면 상단에 수집 신선도를 띄우기 위한 최소 정보. */
export function getLastRun(): LastRunSummary | null {
  return withDb((db) => {
    const rows = toPlain<LastRunSummary>(
      db.prepare("SELECT status, started_at, error FROM runs ORDER BY run_id DESC LIMIT 1").all(),
    );
    return rows[0] ?? null;
  });
}

/** 케이스를 열었을 때 해당 시점까지 확인한 것으로 표시한다. */
export function markCaseRead(requestId: number): void {
  withDb((db) => {
    const rows = db
      .prepare("SELECT COALESCE(MAX(res_date_ms), 0) AS m FROM threads WHERE request_id = ?")
      .all(requestId) as unknown as Array<{ m: number }>;
    const latest = rows[0]?.m ?? 0;
    db.prepare(
      `INSERT INTO case_reads (request_id, last_read_thread_ms, read_at) VALUES (?, ?, ?)
       ON CONFLICT(request_id) DO UPDATE SET
         last_read_thread_ms = MAX(case_reads.last_read_thread_ms, excluded.last_read_thread_ms),
         read_at = excluded.read_at`,
    ).run(requestId, latest, new Date().toISOString());
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

export function listAttachments(requestId: number): AttachmentViewRow[] {
  return withDb((db) =>
    toPlain<AttachmentViewRow>(
      db
        .prepare(
          `SELECT document_id, thread_id, doc_name, doc_path, content_type,
                  file_size, uploaded_by, uploaded_at, uploaded_ms
           FROM attachments WHERE request_id = ?
           ORDER BY uploaded_ms ASC, document_id ASC`,
        )
        .all(requestId),
    ),
  );
}

/** 사이드바에 쓰는 건수. 매 페이지 렌더마다 호출되므로 가볍게 센다. */
export function countsForNav(): {
  open: number; closed: number; unread: number; cves: number; criticalCves: number;
} {
  return withDb((db) => {
    const rows = db
      .prepare(
        `SELECT c.status AS status,
                (SELECT COUNT(*) FROM threads t
                  WHERE t.request_id = c.request_id AND t.is_ours = 0
                    AND COALESCE(t.res_date_ms, 0) >
                        COALESCE((SELECT r.last_read_thread_ms FROM case_reads r
                                   WHERE r.request_id = c.request_id), 0)) AS unread
         FROM cases c`,
      )
      .all() as Array<{ status: string; unread: number }>;

    let open = 0;
    let closed = 0;
    let unread = 0;
    for (const row of rows) {
      if (isClosedStatus(row.status)) closed += 1;
      else {
        open += 1;
        if (row.unread > 0) unread += 1;
      }
    }
    const cveRows = db
      .prepare("SELECT severity FROM cves")
      .all() as Array<{ severity: string }>;
    const criticalCves = cveRows.filter((r) => r.severity === "CRITICAL").length;

    return { open, closed, unread, cves: cveRows.length, criticalCves };
  });
}

/** 정리본이 작성된 케이스 수. */
export function countSummaries(): number {
  return withDb((db) => {
    const rows = db
      .prepare("SELECT COUNT(DISTINCT request_id) AS c FROM case_summaries")
      .all() as Array<{ c: number }>;
    return rows[0]?.c ?? 0;
  });
}

/** 기존 케이스에서 고객사·제품 같은 목록을 뽑는다. 작성 폼의 선택지로 쓴다. */
export function listDistinct(column: "party_name" | "category"): string[] {
  return withDb((db) => {
    const rows = db
      .prepare(
        `SELECT ${column} AS v, COUNT(*) AS c FROM cases
          WHERE ${column} <> '' GROUP BY ${column} ORDER BY c DESC LIMIT 40`,
      )
      .all() as Array<{ v: string }>;
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

export function listCves(): CveViewRow[] {
  return withDb((db) =>
    toPlain<CveViewRow>(
      db
        .prepare(
          `SELECT cve_id, product, severity, score, published, modified,
                  summary, summary_ko, url, first_seen, dismissed
             FROM cves
            ORDER BY published DESC, cve_id DESC
            LIMIT 400`,
        )
        .all(),
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
export function getCve(cveId: string): CveDetailRow[] {
  return withDb((db) =>
    toPlain<CveDetailRow>(
      db.prepare("SELECT * FROM cves WHERE cve_id = ? ORDER BY product").all(cveId),
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
 *
 * 보고서는 "그 달에 발생한 SR" 기준이라 생성일로 자른다.
 * month 는 'YYYY-MM'.
 */
export function listCasesInMonth(month: string): MonthCaseRow[] {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const start = new Date(y, m - 1, 1).getTime();
  const end = new Date(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1).getTime();

  return withDb((db) =>
    toPlain<MonthCaseRow>(
      db
        .prepare(
          `SELECT c.request_id, c.request_id_formatted, c.subject, c.status, c.priority,
                  c.category, c.party_name, c.created_on, c.created_on_ms, c.last_updated,
                  COALESCE((SELECT t.body_text FROM threads t
                             WHERE t.request_id = c.request_id AND t.is_ours = 0
                             ORDER BY t.res_date_ms DESC LIMIT 1), '') AS last_reply
             FROM cases c
            WHERE c.created_on_ms >= ? AND c.created_on_ms < ?
            ORDER BY c.created_on_ms ASC`,
        )
        .all(start, end),
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
export function listProductComponents(): ProductComponent[] {
  return withDb((db) =>
    toPlain<ProductComponent>(
      db
        .prepare(
          `SELECT product_id AS productId, product_name AS productName,
                  component_id AS componentId, component_name AS componentName,
                  COUNT(*) AS used
             FROM cases
            WHERE product_id IS NOT NULL AND product_name <> ''
              AND component_id IS NOT NULL AND component_name <> ''
            GROUP BY product_id, component_id
            ORDER BY productName, used DESC`,
        )
        .all(),
    ),
  );
}
