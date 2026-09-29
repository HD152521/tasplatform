/**
 * 첨부 작업 큐 — 웹(브라우저 없음) → 수집기 VM(브라우저 있음).
 *
 * 첨부는 supportftp(CrushFTP)에 있고, 거기 로그인은 **진짜 브라우저**가 있어야 끝난다.
 * redirect.html 이 302 가 아니라 JS 로 이동시키기 때문이다(lib/crushftp.ts 머리말).
 * 그래서 웹은 "해달라" 고 행을 넣고, worker 가 브라우저를 띄워 처리한다.
 *
 * ## 상태
 *
 *   pending → running → done | failed
 *
 * running 에서 멈춘 채 남는 경우가 있다 — worker 가 처리 중에 죽으면 아무도 그 행을
 * 끝내주지 않는다. 그래서 오래된 running 은 다시 pending 으로 돌린다(reviveStuckJobs).
 * 되살리지 않으면 사람은 영원히 "처리 중" 만 본다.
 *
 * ## payload
 *
 * base64 문자열이다. SQLite 의 BLOB 과 Postgres 의 BYTEA 를 가르지 않으려는 것이고,
 * 용량이 33% 늘지만 상한이 작아서 괜찮다. **일이 끝나면 비운다** — 케이스 첨부가 DB 에
 * 쌓이면 안 된다.
 *
 * server-only 를 붙이지 않는다. 수집기(Node)에서도 부른다.
 */
import { isoNow } from "./dates.ts";
import type { Db } from "./db.ts";

export type JobKind = "upload" | "download";
export type JobState = "pending" | "running" | "done" | "failed";

export interface AttachmentJob {
  job_id: number;
  kind: JobKind;
  request_id: number;
  document_id: number;
  file_name: string;
  payload: string;
  state: JobState;
  error: string;
  actor: string;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  "job_id, kind, request_id, document_id, file_name, payload, state, error, actor, created_at, updated_at";

/** payload 를 뺀 조회. 목록·상태 확인에 쓴다 — 큰 문자열을 괜히 끌고 오지 않는다. */
const LIGHT_COLUMNS =
  "job_id, kind, request_id, document_id, file_name, '' AS payload, state, error, actor, created_at, updated_at";

export interface EnqueueUpload {
  readonly requestId: number;
  readonly fileName: string;
  /** 올릴 파일. base64. */
  readonly payload: string;
  readonly actor?: string;
}

/** 올릴 파일을 큐에 넣는다. */
export async function enqueueUpload(db: Db, job: EnqueueUpload): Promise<number> {
  const now = isoNow();
  return await db.insertReturning(
    `INSERT INTO attachment_jobs
       (kind, request_id, document_id, file_name, payload, state, error, actor, created_at, updated_at)
     VALUES ('upload', ?, 0, ?, ?, 'pending', '', ?, ?, ?)`,
    [job.requestId, job.fileName, job.payload, job.actor ?? "", now, now],
    "job_id",
  );
}

export interface EnqueueDownload {
  readonly requestId: number;
  readonly documentId: number;
  readonly fileName: string;
  readonly actor?: string;
}

/**
 * 받아올 첨부를 큐에 넣는다.
 *
 * 같은 첨부가 이미 대기·처리 중이면 그 행을 그대로 돌려준다. 사람이 여러 번 눌러도
 * 브라우저를 여러 번 띄우지 않는다 — 한 번 띄우는 데 10초가 든다.
 */
export async function enqueueDownload(db: Db, job: EnqueueDownload): Promise<number> {
  const live = await db.get<{ job_id: number }>(
    `SELECT job_id FROM attachment_jobs
      WHERE kind = 'download' AND document_id = ? AND state IN ('pending','running')
      ORDER BY job_id DESC LIMIT 1`,
    [job.documentId],
  );
  if (live !== undefined) return live.job_id;

  const now = isoNow();
  return await db.insertReturning(
    `INSERT INTO attachment_jobs
       (kind, request_id, document_id, file_name, payload, state, error, actor, created_at, updated_at)
     VALUES ('download', ?, ?, ?, '', 'pending', '', ?, ?, ?)`,
    [job.requestId, job.documentId, job.fileName, job.actor ?? "", now, now],
    "job_id",
  );
}

/** 대기 중인 일이 있는가. worker 가 브라우저를 띄울지 정하는 데 쓴다. */
export async function hasPendingJobs(db: Db): Promise<boolean> {
  const row = await db.get<{ job_id: number }>(
    "SELECT job_id FROM attachment_jobs WHERE state = 'pending' ORDER BY job_id LIMIT 1",
  );
  return row !== undefined;
}

/**
 * 다음 일을 집어 running 으로 바꾼다. 없으면 null.
 *
 * 수집기는 한 대뿐이라 경쟁이 없다. 그래도 state 조건을 UPDATE 에 실어, 혹시 둘이
 * 돌더라도 같은 일을 두 번 하지 않게 한다.
 */
export async function claimNextJob(db: Db): Promise<AttachmentJob | null> {
  const next = await db.get<AttachmentJob>(
    `SELECT ${COLUMNS} FROM attachment_jobs WHERE state = 'pending' ORDER BY job_id LIMIT 1`,
  );
  if (next === undefined) return null;

  const now = isoNow();
  await db.run(
    "UPDATE attachment_jobs SET state = 'running', updated_at = ? WHERE job_id = ? AND state = 'pending'",
    [now, next.job_id],
  );
  const claimed = await db.get<AttachmentJob>(
    `SELECT ${COLUMNS} FROM attachment_jobs WHERE job_id = ? AND state = 'running'`,
    [next.job_id],
  );
  return claimed ?? null;
}

/**
 * 일을 끝낸다.
 *
 * 업로드는 payload 를 비운다 — 이미 올렸으니 DB 에 들고 있을 이유가 없다.
 * 다운로드는 받은 내용을 payload 에 담는다.
 */
export async function finishJob(
  db: Db,
  jobId: number,
  result: { payload?: string; error?: string },
): Promise<void> {
  const failed = (result.error ?? "") !== "";
  await db.run(
    `UPDATE attachment_jobs
        SET state = ?, payload = ?, error = ?, updated_at = ?
      WHERE job_id = ?`,
    [failed ? "failed" : "done", result.payload ?? "", result.error ?? "", isoNow(), jobId],
  );
}

/** 상태 확인용. payload 는 빼고 준다. */
export async function getJobStatus(db: Db, jobId: number): Promise<AttachmentJob | null> {
  const row = await db.get<AttachmentJob>(
    `SELECT ${LIGHT_COLUMNS} FROM attachment_jobs WHERE job_id = ?`,
    [jobId],
  );
  return row ?? null;
}

/** 받아 둔 내용을 꺼낸다. 없으면 null. */
export async function getJobPayload(db: Db, jobId: number): Promise<AttachmentJob | null> {
  const row = await db.get<AttachmentJob>(
    `SELECT ${COLUMNS} FROM attachment_jobs WHERE job_id = ?`,
    [jobId],
  );
  return row ?? null;
}

/**
 * 처리 중에 죽어 남은 일을 되살린다.
 *
 * worker 가 브라우저를 띄우다 죽거나 재배포로 내려가면 running 인 행이 남는다.
 * 아무도 끝내주지 않으므로 사람은 영원히 "처리 중" 만 본다. 오래된 것은 다시 줄에 세운다.
 * 되돌린 건수를 돌려준다.
 */
export async function reviveStuckJobs(db: Db, olderThanMs = 15 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const stuck = await db.all<{ job_id: number }>(
    "SELECT job_id FROM attachment_jobs WHERE state = 'running' AND updated_at < ?",
    [cutoff],
  );
  const rows = stuck as Array<{ job_id: number }>;
  if (rows.length === 0) return 0;
  await db.run(
    "UPDATE attachment_jobs SET state = 'pending', updated_at = ? WHERE state = 'running' AND updated_at < ?",
    [isoNow(), cutoff],
  );
  return rows.length;
}

/**
 * 오래된 일을 지운다.
 *
 * 받아 둔 첨부가 DB 에 쌓이면 안 된다. 끝난 일은 사람이 이미 받아 갔고, 다시 필요하면
 * 다시 요청하면 된다(브라우저로 6초다).
 */
export async function purgeOldJobs(db: Db, olderThanMs = 24 * 60 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const old = (await db.all<{ job_id: number }>(
    "SELECT job_id FROM attachment_jobs WHERE state IN ('done','failed') AND updated_at < ?",
    [cutoff],
  )) as Array<{ job_id: number }>;
  if (old.length === 0) return 0;
  await db.run(
    "DELETE FROM attachment_jobs WHERE state IN ('done','failed') AND updated_at < ?",
    [cutoff],
  );
  return old.length;
}
