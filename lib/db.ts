/** node:sqlite(Node 24 내장) 위의 얇은 래퍼. 네이티브 빌드가 필요 없다. */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DB_FILE } from "./config.ts";
import { SCHEMA_SQL } from "./schema.ts";
import { isoNow } from "./dates.ts";
import type { AttachmentRow, CaseRow, RunRow, RunStatus, ThreadRow } from "./types.ts";

export function openDb(file: string = DB_FILE): DatabaseSync {
  const path = resolve(file);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  migrate(db);
  return db;
}

/**
 * 이미 만들어진 DB 에 나중에 추가된 컬럼을 채워 넣는다.
 * CREATE TABLE IF NOT EXISTS 는 기존 테이블의 컬럼을 늘려주지 않는다.
 */
const ADDED_COLUMNS: ReadonlyArray<{ table: string; column: string; ddl: string }> = [
  { table: "cases", column: "description_html", ddl: "TEXT NOT NULL DEFAULT ''" },
  { table: "cases", column: "description_text", ddl: "TEXT NOT NULL DEFAULT ''" },
  { table: "cases", column: "case_version", ddl: "INTEGER" },
  { table: "cases", column: "product_id", ddl: "INTEGER" },
  { table: "cases", column: "product_name", ddl: "TEXT NOT NULL DEFAULT ''" },
  { table: "cases", column: "component_id", ddl: "INTEGER" },
  { table: "cases", column: "component_name", ddl: "TEXT NOT NULL DEFAULT ''" },
  { table: "cves", column: "vector", ddl: "TEXT NOT NULL DEFAULT ''" },
  { table: "cves", column: "attack_vector", ddl: "TEXT NOT NULL DEFAULT ''" },
  { table: "cves", column: "attack_complexity", ddl: "TEXT NOT NULL DEFAULT ''" },
  { table: "cves", column: "privileges_required", ddl: "TEXT NOT NULL DEFAULT ''" },
  { table: "cves", column: "user_interaction", ddl: "TEXT NOT NULL DEFAULT ''" },
  { table: "cves", column: "impact_c", ddl: "TEXT NOT NULL DEFAULT ''" },
  { table: "cves", column: "impact_i", ddl: "TEXT NOT NULL DEFAULT ''" },
  { table: "cves", column: "impact_a", ddl: "TEXT NOT NULL DEFAULT ''" },
  { table: "cves", column: "cwe", ddl: "TEXT NOT NULL DEFAULT ''" },
  { table: "cves", column: "references_json", ddl: "TEXT NOT NULL DEFAULT '[]'" },
  { table: "cves", column: "affected_json", ddl: "TEXT NOT NULL DEFAULT '[]'" },
  { table: "cves", column: "summary_ko", ddl: "TEXT NOT NULL DEFAULT ''" },
  { table: "cves", column: "brief_ko", ddl: "TEXT NOT NULL DEFAULT ''" },
];

function migrate(db: DatabaseSync): void {
  for (const { table, column, ddl } of ADDED_COLUMNS) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (existing.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

export function getExistingCaseIndex(db: DatabaseSync): Map<number, string> {
  const rows = db
    .prepare("SELECT request_id, last_updated FROM cases")
    .all() as Array<{ request_id: number; last_updated: string }>;
  return new Map(rows.map((r) => [r.request_id, r.last_updated]));
}

export function getKnownThreadIds(db: DatabaseSync, requestId: number): Set<number> {
  const rows = db
    .prepare("SELECT thread_id FROM threads WHERE request_id = ?")
    .all(requestId) as Array<{ thread_id: number }>;
  return new Set(rows.map((r) => r.thread_id));
}

export function upsertCase(db: DatabaseSync, row: Omit<CaseRow, "first_seen_at">): void {
  db.prepare(
    `INSERT INTO cases (
       request_id, request_id_formatted, subject, status, priority, category,
       party_name, party_site_number, created_on, created_on_ms,
       last_updated, last_updated_ms, first_seen_at, last_fetched_at, raw_json,
       description_html, description_text, case_version,
       product_id, product_name, component_id, component_name
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(request_id) DO UPDATE SET
       request_id_formatted = excluded.request_id_formatted,
       subject              = excluded.subject,
       status               = excluded.status,
       priority             = excluded.priority,
       category             = excluded.category,
       party_name           = excluded.party_name,
       party_site_number    = excluded.party_site_number,
       created_on           = excluded.created_on,
       created_on_ms        = excluded.created_on_ms,
       last_updated         = excluded.last_updated,
       last_updated_ms      = excluded.last_updated_ms,
       last_fetched_at      = excluded.last_fetched_at,
       raw_json             = excluded.raw_json,
       -- 본문 조회에 실패한 회차가 기존 본문을 지우지 않도록 빈 값이면 유지한다
       description_html     = CASE WHEN excluded.description_html = '' THEN cases.description_html ELSE excluded.description_html END,
       description_text     = CASE WHEN excluded.description_text = '' THEN cases.description_text ELSE excluded.description_text END,
       case_version         = COALESCE(excluded.case_version, cases.case_version),
       product_id           = COALESCE(excluded.product_id, cases.product_id),
       product_name         = CASE WHEN excluded.product_name = '' THEN cases.product_name ELSE excluded.product_name END,
       component_id         = COALESCE(excluded.component_id, cases.component_id),
       component_name       = CASE WHEN excluded.component_name = '' THEN cases.component_name ELSE excluded.component_name END`,
  ).run(
    row.request_id, row.request_id_formatted, row.subject, row.status,
    row.priority, row.category, row.party_name, row.party_site_number,
    row.created_on, row.created_on_ms, row.last_updated, row.last_updated_ms,
    row.last_fetched_at, row.last_fetched_at, row.raw_json,
    row.description_html, row.description_text, row.case_version,
    row.product_id, row.product_name, row.component_id, row.component_name,
  );
}

export function upsertThread(db: DatabaseSync, row: ThreadRow): void {
  db.prepare(
    `INSERT INTO threads (
       thread_id, request_id, author_unit, author_unit_id, is_ours,
       res_date_ms, res_date_val, body_html, body_text, fetched_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(thread_id) DO UPDATE SET
       author_unit  = excluded.author_unit,
       is_ours      = excluded.is_ours,
       body_html    = excluded.body_html,
       body_text    = excluded.body_text,
       fetched_at   = excluded.fetched_at`,
  ).run(
    row.thread_id, row.request_id, row.author_unit, row.author_unit_id,
    row.is_ours, row.res_date_ms, row.res_date_val,
    row.body_html, row.body_text, row.fetched_at,
  );
}

export function upsertAttachment(db: DatabaseSync, row: AttachmentRow): void {
  db.prepare(
    `INSERT INTO attachments (
       document_id, request_id, thread_id, doc_name, doc_path, content_type,
       file_size, uploaded_by, uploaded_at, uploaded_ms, fetched_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(document_id) DO UPDATE SET
       doc_name   = excluded.doc_name,
       doc_path   = excluded.doc_path,
       file_size  = excluded.file_size,
       fetched_at = excluded.fetched_at`,
  ).run(
    row.document_id, row.request_id, row.thread_id, row.doc_name, row.doc_path,
    row.content_type, row.file_size, row.uploaded_by, row.uploaded_at,
    row.uploaded_ms, row.fetched_at,
  );
}

export function upsertCve(
  db: DatabaseSync,
  row: {
    cve_id: string; product: string; keyword: string; severity: string;
    score: number | null; published: string; modified: string;
    summary: string; url: string; fetched_at: string;
    vector: string; attack_vector: string; attack_complexity: string;
    privileges_required: string; user_interaction: string;
    impact_c: string; impact_i: string; impact_a: string;
    cwe: string; references_json: string; affected_json: string;
  },
): boolean {
  const before = db
    .prepare("SELECT 1 AS x FROM cves WHERE cve_id = ? AND product = ?")
    .all(row.cve_id, row.product);
  db.prepare(
    `INSERT INTO cves (
       cve_id, product, keyword, severity, score, published, modified,
       summary, url, fetched_at, first_seen,
       vector, attack_vector, attack_complexity, privileges_required,
       user_interaction, impact_c, impact_i, impact_a, cwe,
       references_json, affected_json
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(cve_id, product) DO UPDATE SET
       severity = excluded.severity,
       score = excluded.score,
       modified = excluded.modified,
       summary = excluded.summary,
       fetched_at = excluded.fetched_at,
       vector = excluded.vector,
       attack_vector = excluded.attack_vector,
       attack_complexity = excluded.attack_complexity,
       privileges_required = excluded.privileges_required,
       user_interaction = excluded.user_interaction,
       impact_c = excluded.impact_c,
       impact_i = excluded.impact_i,
       impact_a = excluded.impact_a,
       cwe = excluded.cwe,
       references_json = excluded.references_json,
       affected_json = excluded.affected_json`,
  ).run(
    row.cve_id, row.product, row.keyword, row.severity, row.score,
    row.published, row.modified, row.summary, row.url, row.fetched_at, row.fetched_at,
    row.vector, row.attack_vector, row.attack_complexity, row.privileges_required,
    row.user_interaction, row.impact_c, row.impact_i, row.impact_a, row.cwe,
    row.references_json, row.affected_json,
  );
  return before.length === 0; // 새로 들어온 것인지
}

export function startRun(db: DatabaseSync): number {
  const info = db
    .prepare("INSERT INTO runs (started_at, status, session_state) VALUES (?, 'failed', 'unknown')")
    .run(isoNow());
  return Number(info.lastInsertRowid);
}

export function finishRun(
  db: DatabaseSync,
  runId: number,
  patch: {
    status: RunStatus;
    casesSeen?: number;
    casesChanged?: number;
    newThreads?: number;
    sessionState: string;
    error?: string | null;
  },
): void {
  db.prepare(
    `UPDATE runs SET finished_at = ?, status = ?, cases_seen = ?, cases_changed = ?,
                     new_threads = ?, session_state = ?, error = ?
     WHERE run_id = ?`,
  ).run(
    isoNow(), patch.status, patch.casesSeen ?? 0, patch.casesChanged ?? 0,
    patch.newThreads ?? 0, patch.sessionState, patch.error ?? null, runId,
  );
}

export function listRuns(db: DatabaseSync, limit = 30): RunRow[] {
  // node:sqlite 결과는 프로토타입이 없다. 클라이언트로 넘어갈 수 있으므로 평범한 객체로 바꾼다.
  return db
    .prepare("SELECT * FROM runs ORDER BY run_id DESC LIMIT ?")
    .all(limit)
    .map((row) => ({ ...(row as object) })) as RunRow[];
}
