/**
 * DB 스키마.
 *
 * 파일(.sql)이 아니라 문자열 상수로 둔다.
 * Next.js 번들 환경에서는 readFileSync(new URL(...)) 이 동작하지 않아
 * 서버 컴포넌트가 스키마를 읽지 못한다(실측 확인).
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cases (
  request_id           INTEGER PRIMARY KEY,
  request_id_formatted TEXT    NOT NULL,
  subject              TEXT    NOT NULL DEFAULT '',
  status               TEXT    NOT NULL DEFAULT '',
  priority             TEXT    NOT NULL DEFAULT '',
  category             TEXT    NOT NULL DEFAULT '',
  party_name           TEXT    NOT NULL DEFAULT '',
  party_site_number    TEXT    NOT NULL DEFAULT '',
  created_on           TEXT    NOT NULL DEFAULT '',
  created_on_ms        INTEGER,
  last_updated         TEXT    NOT NULL DEFAULT '',
  last_updated_ms      INTEGER,
  first_seen_at        TEXT    NOT NULL,
  last_fetched_at      TEXT    NOT NULL,
  raw_json             TEXT    NOT NULL DEFAULT '{}',
  -- 케이스를 최초 등록할 때 우리가 쓴 본문. 스레드가 아니라 별도 필드로 온다.
  description_html     TEXT    NOT NULL DEFAULT '',
  description_text     TEXT    NOT NULL DEFAULT '',
  -- 답변 등록 시 필요한 낙관적 잠금 값
  case_version         INTEGER,
  -- SR 작성 폼의 Product / Component. 실제로 쓰인 조합을 모으기 위해 저장한다.
  product_id           INTEGER,
  product_name         TEXT NOT NULL DEFAULT '',
  component_id         INTEGER,
  component_name       TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_cases_last_updated ON cases(last_updated_ms DESC);

CREATE TABLE IF NOT EXISTS threads (
  thread_id      INTEGER PRIMARY KEY,
  request_id     INTEGER NOT NULL,
  author_unit    TEXT    NOT NULL DEFAULT '',
  author_unit_id INTEGER NOT NULL DEFAULT 0,
  -- 1 = 우리가 쓴 글, 0 = 상대(Broadcom) 답변
  is_ours        INTEGER NOT NULL DEFAULT 0,
  res_date_ms    INTEGER,
  res_date_val   TEXT    NOT NULL DEFAULT '',
  body_html      TEXT    NOT NULL DEFAULT '',
  body_text      TEXT    NOT NULL DEFAULT '',
  fetched_at     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_threads_request ON threads(request_id, res_date_ms DESC);

-- 수집 실행 이력.
-- status 를 3값으로 구분하는 것이 핵심이다.
--   success         : 정상 수집
--   session_expired : 세션이 끊겨 조회하지 못함  <- '새 답변 0건'과 절대 같지 않다
--   failed          : 그 외 실패
CREATE TABLE IF NOT EXISTS runs (
  run_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT    NOT NULL,
  finished_at   TEXT,
  status        TEXT    NOT NULL,
  cases_seen    INTEGER NOT NULL DEFAULT 0,
  cases_changed INTEGER NOT NULL DEFAULT 0,
  new_threads   INTEGER NOT NULL DEFAULT 0,
  session_state TEXT    NOT NULL DEFAULT '',
  error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);

-- 팀이 어디까지 확인했는지. 계정을 공유하므로 팀 단위 읽음 상태로 둔다.
-- last_read_thread_ms 보다 새로운 상대 답변이 있으면 '새 답변'이다.
-- NVD 에서 가져온 보안 취약점.
-- 우리가 지원하는 제품 키워드로 조회한 결과이며, 키워드 매칭이라 무관한 것이 섞일 수 있다.
-- dismissed = 1 이면 화면에서 숨긴다(관련 없다고 판단한 것).
CREATE TABLE IF NOT EXISTS cves (
  cve_id     TEXT NOT NULL,
  product    TEXT NOT NULL,
  keyword    TEXT NOT NULL DEFAULT '',
  severity   TEXT NOT NULL DEFAULT '',
  score      REAL,
  published  TEXT NOT NULL DEFAULT '',
  modified   TEXT NOT NULL DEFAULT '',
  summary    TEXT NOT NULL DEFAULT '',
  url        TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  dismissed  INTEGER NOT NULL DEFAULT 0,
  vector              TEXT NOT NULL DEFAULT '',
  attack_vector       TEXT NOT NULL DEFAULT '',
  attack_complexity   TEXT NOT NULL DEFAULT '',
  privileges_required TEXT NOT NULL DEFAULT '',
  user_interaction    TEXT NOT NULL DEFAULT '',
  impact_c            TEXT NOT NULL DEFAULT '',
  impact_i            TEXT NOT NULL DEFAULT '',
  impact_a            TEXT NOT NULL DEFAULT '',
  cwe                 TEXT NOT NULL DEFAULT '',
  references_json     TEXT NOT NULL DEFAULT '[]',
  affected_json       TEXT NOT NULL DEFAULT '[]',
  -- 한국어 번역. 한 번 만들면 다시 부르지 않는다.
  summary_ko          TEXT NOT NULL DEFAULT '',
  -- 담당자용 3줄 정리 (무엇이 / 영향 / 확인할 것)
  brief_ko            TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (cve_id, product)
);

CREATE INDEX IF NOT EXISTS idx_cves_published ON cves(published DESC);

-- 케이스 첨부파일.
-- 파일 실체는 Broadcom 쪽(supportftp)에 있고 우리는 목록과 링크만 갖는다.
-- 204MB 짜리도 있어서 내려받아 보관하지 않는다.
CREATE TABLE IF NOT EXISTS attachments (
  document_id  INTEGER PRIMARY KEY,
  request_id   INTEGER NOT NULL,
  thread_id    INTEGER,
  doc_name     TEXT    NOT NULL DEFAULT '',
  doc_path     TEXT    NOT NULL DEFAULT '',
  content_type TEXT    NOT NULL DEFAULT '',
  file_size    INTEGER NOT NULL DEFAULT 0,
  uploaded_by  TEXT    NOT NULL DEFAULT '',
  uploaded_at  TEXT    NOT NULL DEFAULT '',
  uploaded_ms  INTEGER,
  fetched_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attachments_request ON attachments(request_id, uploaded_ms DESC);

-- 종료 케이스 정리 결과.
-- 처음 요청할 때 만들어 저장하고, 이후에는 저장분을 그대로 돌려준다.
-- source: draft = 수집 데이터로 엮은 초안, ai = AI 로 다듬은 것
CREATE TABLE IF NOT EXISTS case_summaries (
  request_id   INTEGER NOT NULL,
  kind         TEXT    NOT NULL,
  content      TEXT    NOT NULL,
  source       TEXT    NOT NULL DEFAULT 'draft',
  generated_at TEXT    NOT NULL,
  PRIMARY KEY (request_id, kind)
);

CREATE TABLE IF NOT EXISTS case_reads (
  request_id          INTEGER PRIMARY KEY,
  last_read_thread_ms INTEGER NOT NULL DEFAULT 0,
  read_at             TEXT    NOT NULL
);

-- 정기점검 보고서의 월별 인스턴스 입력값.
-- 결과(container_*)를 같이 저장하는 이유는 다음 달 "전월 대비 증감" 때문이다.
-- 이 값이 있으면 다음 달에는 입력 9개만 넣으면 된다.
-- month 는 'YYYY-MM'.
CREATE TABLE IF NOT EXISTS instance_counts (
  month                TEXT    PRIMARY KEY,
  bank_dev             REAL    NOT NULL,
  bank_prod            REAL    NOT NULL,
  bank_dr              REAL    NOT NULL,
  central_dev          REAL    NOT NULL,
  central_prod         REAL    NOT NULL,
  central_dr           REAL    NOT NULL,
  shared_dev           REAL    NOT NULL,
  shared_prod          REAL    NOT NULL,
  shared_dr            REAL    NOT NULL,
  container_bank_prod         REAL NOT NULL,
  container_bank_prod_shared  REAL NOT NULL,
  container_bank_dev          REAL NOT NULL,
  container_bank_dev_shared   REAL NOT NULL,
  container_central_prod      REAL NOT NULL,
  container_central_dev       REAL NOT NULL,
  -- 이 달을 계산할 때 실제로 쓴 전월값.
  -- 앞선 달이 저장돼 있으면 그 값이 들어가고, 첫 달이면 사람이 넣은 값이 들어간다.
  -- 남겨두면 "무엇과 비교한 증감인지"를 나중에도 알 수 있다.
  prev_bank_prod         REAL NOT NULL DEFAULT 0,
  prev_bank_prod_shared  REAL NOT NULL DEFAULT 0,
  prev_bank_dev          REAL NOT NULL DEFAULT 0,
  prev_bank_dev_shared   REAL NOT NULL DEFAULT 0,
  prev_central_prod      REAL NOT NULL DEFAULT 0,
  prev_central_dev       REAL NOT NULL DEFAULT 0,
  saved_at             TEXT    NOT NULL
);

-- 정기점검 보고서에 넣기로 고른 항목들.
-- kind: 'sr' = 케이스 번호, 'jira' = 이슈 키.
-- 단계를 옮겨다녀도 선택이 남아야 해서 저장한다.
CREATE TABLE IF NOT EXISTS report_picks (
  month TEXT    NOT NULL,
  kind  TEXT    NOT NULL,
  ref   TEXT    NOT NULL,
  ord   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (month, kind, ref)
);
`;
