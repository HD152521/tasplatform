/**
 * 데이터 접근 계층.
 *
 * SQLite(로컬/테스트)와 Postgres(TAS)를 lib/dbCore.ts 의 비동기 Db 추상화로 가린다.
 * 모든 쿼리 함수는 async 다 — 방언에 상관없이 같은 코드가 돈다.
 */
import { DEFAULT_TEAM_ID } from "./config.ts";
import { schemaSqlFor } from "./schema.ts";
import { isoNow } from "./dates.ts";
import { createDb, type Db } from "./dbCore.ts";
import { resolveDbTarget } from "./dbConn.ts";
import type { AttachmentRow, CaseRow, RunRow, RunStatus, ThreadRow } from "./types.ts";

export type { Db } from "./dbCore.ts";

/**
 * DB 를 연다. file 을 주면 그 SQLite 파일(테스트·명시 경로)을, 안 주면 환경(DATABASE_URL/
 * VCAP_SERVICES → Postgres, 없으면 기본 SQLite)을 따른다. 스키마·마이그레이션·기본 팀 시드까지 마친다.
 */
export async function openDb(file?: string): Promise<Db> {
  const target = file ? { dialect: "sqlite" as const, file } : resolveDbTarget();
  const db = createDb(target);
  await db.exec(schemaSqlFor(db.dialect));
  await migrate(db);
  await seedDefaults(db);
  return db;
}

/** 기본 팀이 없으면 만든다. 기존 케이스가 이 팀에 귀속되므로 반드시 존재해야 한다. */
async function seedDefaults(db: Db): Promise<void> {
  await db.run(
    "INSERT INTO teams (team_id, team_name, broadcom_username, created_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING",
    [DEFAULT_TEAM_ID, "기본 팀", process.env.SR_USERNAME ?? "", isoNow()],
  );
}

/** 여러 행 쓰기를 한 트랜잭션으로 묶는다. 콜백에서 던지면 되돌린다. */
export function inTransaction<T>(db: Db, run: (tx: Db) => Promise<T>): Promise<T> {
  return db.tx(run);
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
  // 팀(공용 계정) 소유. 기존 행은 전부 기본 팀에 귀속된다.
  { table: "cases", column: "team_id", ddl: `TEXT NOT NULL DEFAULT '${DEFAULT_TEAM_ID}'` },
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
  { table: "instance_counts", column: "prev_bank_prod", ddl: "REAL NOT NULL DEFAULT 0" },
  { table: "instance_counts", column: "prev_bank_prod_shared", ddl: "REAL NOT NULL DEFAULT 0" },
  { table: "instance_counts", column: "prev_bank_dev", ddl: "REAL NOT NULL DEFAULT 0" },
  { table: "instance_counts", column: "prev_bank_dev_shared", ddl: "REAL NOT NULL DEFAULT 0" },
  { table: "instance_counts", column: "prev_central_prod", ddl: "REAL NOT NULL DEFAULT 0" },
  { table: "instance_counts", column: "prev_central_dev", ddl: "REAL NOT NULL DEFAULT 0" },
];

/** 테이블의 현재 컬럼 이름 집합(방언별 조회). */
async function columnNames(db: Db, table: string): Promise<Set<string>> {
  if (db.dialect === "postgres") {
    const rows = await db.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = ?",
      [table],
    );
    return new Set(rows.map((r) => r.column_name));
  }
  const rows = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
  return new Set(rows.map((r) => r.name));
}

async function migrate(db: Db): Promise<void> {
  // 테이블별로 한 번만 컬럼을 조회해 반복 질의를 줄인다.
  const seen = new Map<string, Set<string>>();
  for (const { table, column, ddl } of ADDED_COLUMNS) {
    let cols = seen.get(table);
    if (!cols) {
      cols = await columnNames(db, table);
      seen.set(table, cols);
    }
    if (cols.has(column)) continue;
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    cols.add(column);
  }
}

export async function getExistingCaseIndex(db: Db): Promise<Map<number, string>> {
  const rows = await db.all<{ request_id: number; last_updated: string }>(
    "SELECT request_id, last_updated FROM cases",
  );
  return new Map(rows.map((r) => [r.request_id, r.last_updated]));
}

export async function getKnownThreadIds(db: Db, requestId: number): Promise<Set<number>> {
  const rows = await db.all<{ thread_id: number }>(
    "SELECT thread_id FROM threads WHERE request_id = ?",
    [requestId],
  );
  return new Set(rows.map((r) => r.thread_id));
}

/**
 * team_id 는 이월 항목 처리: 새/갱신 케이스가 어느 팀 소유인지 기록한다.
 * row.team_id 를 생략하면(기존 수집기·기본팀 호출부) 기본 팀으로 채운다.
 */
export async function upsertCase(db: Db, row: Omit<CaseRow, "first_seen_at">): Promise<void> {
  const teamId = row.team_id ?? DEFAULT_TEAM_ID;
  await db.run(
    `INSERT INTO cases (
       request_id, request_id_formatted, subject, status, priority, category,
       party_name, party_site_number, created_on, created_on_ms,
       last_updated, last_updated_ms, first_seen_at, last_fetched_at, raw_json,
       description_html, description_text, case_version,
       product_id, product_name, component_id, component_name, team_id
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
       description_html     = CASE WHEN excluded.description_html = '' THEN cases.description_html ELSE excluded.description_html END,
       description_text     = CASE WHEN excluded.description_text = '' THEN cases.description_text ELSE excluded.description_text END,
       case_version         = COALESCE(excluded.case_version, cases.case_version),
       product_id           = COALESCE(excluded.product_id, cases.product_id),
       product_name         = CASE WHEN excluded.product_name = '' THEN cases.product_name ELSE excluded.product_name END,
       component_id         = COALESCE(excluded.component_id, cases.component_id),
       component_name       = CASE WHEN excluded.component_name = '' THEN cases.component_name ELSE excluded.component_name END`,
    [
      row.request_id, row.request_id_formatted, row.subject, row.status,
      row.priority, row.category, row.party_name, row.party_site_number,
      row.created_on, row.created_on_ms, row.last_updated, row.last_updated_ms,
      row.last_fetched_at, row.last_fetched_at, row.raw_json,
      row.description_html, row.description_text, row.case_version,
      row.product_id, row.product_name, row.component_id, row.component_name, teamId,
    ],
  );
}

export async function upsertThread(db: Db, row: ThreadRow): Promise<void> {
  await db.run(
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
    [
      row.thread_id, row.request_id, row.author_unit, row.author_unit_id,
      row.is_ours, row.res_date_ms, row.res_date_val,
      row.body_html, row.body_text, row.fetched_at,
    ],
  );
}

export async function upsertAttachment(db: Db, row: AttachmentRow): Promise<void> {
  await db.run(
    `INSERT INTO attachments (
       document_id, request_id, thread_id, doc_name, doc_path, content_type,
       file_size, uploaded_by, uploaded_at, uploaded_ms, fetched_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(document_id) DO UPDATE SET
       doc_name   = excluded.doc_name,
       doc_path   = excluded.doc_path,
       file_size  = excluded.file_size,
       fetched_at = excluded.fetched_at`,
    [
      row.document_id, row.request_id, row.thread_id, row.doc_name, row.doc_path,
      row.content_type, row.file_size, row.uploaded_by, row.uploaded_at,
      row.uploaded_ms, row.fetched_at,
    ],
  );
}

export async function upsertCve(
  db: Db,
  row: {
    cve_id: string; product: string; keyword: string; severity: string;
    score: number | null; published: string; modified: string;
    summary: string; url: string; fetched_at: string;
    vector: string; attack_vector: string; attack_complexity: string;
    privileges_required: string; user_interaction: string;
    impact_c: string; impact_i: string; impact_a: string;
    cwe: string; references_json: string; affected_json: string;
  },
): Promise<boolean> {
  const before = await db.all(
    "SELECT 1 AS x FROM cves WHERE cve_id = ? AND product = ?",
    [row.cve_id, row.product],
  );
  await db.run(
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
    [
      row.cve_id, row.product, row.keyword, row.severity, row.score,
      row.published, row.modified, row.summary, row.url, row.fetched_at, row.fetched_at,
      row.vector, row.attack_vector, row.attack_complexity, row.privileges_required,
      row.user_interaction, row.impact_c, row.impact_i, row.impact_a, row.cwe,
      row.references_json, row.affected_json,
    ],
  );
  return before.length === 0; // 새로 들어온 것인지
}

export async function startRun(db: Db): Promise<number> {
  return db.insertReturning(
    "INSERT INTO runs (started_at, status, session_state) VALUES (?, 'failed', 'unknown')",
    [isoNow()],
    "run_id",
  );
}

export async function finishRun(
  db: Db,
  runId: number,
  patch: {
    status: RunStatus;
    casesSeen?: number;
    casesChanged?: number;
    newThreads?: number;
    sessionState: string;
    error?: string | null;
  },
): Promise<void> {
  await db.run(
    `UPDATE runs SET finished_at = ?, status = ?, cases_seen = ?, cases_changed = ?,
                     new_threads = ?, session_state = ?, error = ?
     WHERE run_id = ?`,
    [
      isoNow(), patch.status, patch.casesSeen ?? 0, patch.casesChanged ?? 0,
      patch.newThreads ?? 0, patch.sessionState, patch.error ?? null, runId,
    ],
  );
}

export async function listRuns(db: Db, limit = 30): Promise<RunRow[]> {
  const rows = await db.all("SELECT * FROM runs ORDER BY run_id DESC LIMIT ?", [limit]);
  return rows.map((row) => ({ ...(row as object) })) as RunRow[];
}

// ── 팀 / 감사 로그 ─────────────────────────────────────────────────

export interface TeamRow {
  team_id: string;
  team_name: string;
  broadcom_username: string;
  created_at: string;
}

export async function listTeams(db: Db): Promise<TeamRow[]> {
  const rows = await db.all("SELECT * FROM teams ORDER BY created_at");
  return rows.map((row) => ({ ...(row as object) })) as TeamRow[];
}

export async function getTeam(db: Db, teamId: string): Promise<TeamRow | null> {
  const row = await db.get("SELECT * FROM teams WHERE team_id = ?", [teamId]);
  return row ? ({ ...(row as object) } as TeamRow) : null;
}

export async function upsertTeam(db: Db, team: Omit<TeamRow, "created_at">): Promise<void> {
  await db.run(
    `INSERT INTO teams (team_id, team_name, broadcom_username, created_at)
     VALUES (?,?,?,?)
     ON CONFLICT(team_id) DO UPDATE SET
       team_name         = excluded.team_name,
       broadcom_username = excluded.broadcom_username`,
    [team.team_id, team.team_name, team.broadcom_username, isoNow()],
  );
}

export interface AuditEntry {
  actor: string;
  teamId: string;
  action: string;
  requestId?: number | null;
  result: string;
  detail?: string;
}

/**
 * 감사 로그 한 줄 기록. 로그 실패가 본 작업을 막지 않도록 예외를 삼킨다.
 * 호출부는 await 로 기다린 뒤 db.close 해야 한다(닫힌 뒤 쓰기 방지).
 */
export async function recordAudit(db: Db, entry: AuditEntry): Promise<void> {
  try {
    await db.run(
      `INSERT INTO audit_log (at, actor, team_id, action, request_id, result, detail)
       VALUES (?,?,?,?,?,?,?)`,
      [
        isoNow(), entry.actor, entry.teamId, entry.action,
        entry.requestId ?? null, entry.result, entry.detail ?? "",
      ],
    );
  } catch {
    // 감사 로그 실패는 본 작업을 막지 않는다
  }
}

export interface AuditRow {
  log_id: number;
  at: string;
  actor: string;
  team_id: string;
  action: string;
  request_id: number | null;
  result: string;
  detail: string;
}

export async function listAudit(db: Db, limit = 100): Promise<AuditRow[]> {
  const rows = await db.all("SELECT * FROM audit_log ORDER BY log_id DESC LIMIT ?", [limit]);
  return rows.map((row) => ({ ...(row as object) })) as AuditRow[];
}
