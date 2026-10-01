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
 * 용량이 33% 늘지만 상한이 작아서 괜찮다.
 *
 * **업로드는 올린 뒤에도 남긴다.** 첨부는 supportftp 의 `files_from_customer` 로 올라가는데
 * 그 폴더는 보관소가 아니라 **투입구**다 — Broadcom 이 케이스로 가져가면 비운다(실측:
 * 올린 지 여덟 시간도 안 되어 같은 주소가 404 였고 폴더 목록도 비어 있었다). 그래서
 * 우리가 올린 파일을 우리가 다시 받을 방법이 없고, 계정을 여러 사람이 공유하니 올린
 * 사람이 아닌 팀원이 받는 것도 안 된다. 이 payload 가 **우리가 보낸 파일의 유일한 사본**이다.
 *
 * 다운로드는 반대다. 남의 파일을 잠깐 받아 둔 임시본이고 원본은 supportftp 에 그대로
 * 있으니 오래 들고 있을 이유가 없다. 보관 기간이 종류별로 다른 까닭이다(purgeOldJobs).
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
 * 다운로드는 받은 내용을 payload 에 담는다.
 *
 * 업로드는 **성공하면 payload 를 그대로 남긴다.** 올린 파일은 supportftp 에서 곧 사라지고
 * (files_from_customer 는 투입구다 — 머리말) 우리가 다시 받을 길이 없으므로, 이 행이 우리가
 * 보낸 파일의 유일한 사본이 된다. 반대로 업로드가 **실패하면 비운다** — 보낸 적이 없으니
 * 사본이라 부를 것도 없고, 올라가지도 않은 바이트를 2주씩 들고 있을 이유가 없다.
 *
 * 종류를 인자로 받지 않고 행에서 읽는다. 호출부(collector/attachments.ts)는 다운로드일 때만
 * payload 를 싣는데, 업로드 성공에서는 그게 undefined 로 와 "비우라" 는 뜻이 되어 버렸다.
 * 판정을 이 함수 안에 두면 호출부를 한 곳도 고치지 않아도 된다.
 */
export async function finishJob(
  db: Db,
  jobId: number,
  result: { payload?: string; error?: string },
): Promise<void> {
  const failed = (result.error ?? "") !== "";
  const row = await db.get<{ kind: JobKind }>(
    "SELECT kind FROM attachment_jobs WHERE job_id = ?",
    [jobId],
  );

  if (!failed && row?.kind === "upload") {
    // payload 를 SET 에서 빼야 올린 내용이 그대로 남는다.
    await db.run(
      "UPDATE attachment_jobs SET state = 'done', error = '', updated_at = ? WHERE job_id = ?",
      [isoNow(), jobId],
    );
    return;
  }

  await db.run(
    `UPDATE attachment_jobs
        SET state = ?, payload = ?, error = ?, updated_at = ?
      WHERE job_id = ?`,
    [failed ? "failed" : "done", result.payload ?? "", result.error ?? "", isoNow(), jobId],
  );
}

/** 우리가 올려 둔 사본 한 건. */
export interface KeptUpload {
  readonly jobId: number;
  /** 올린 파일 그대로. base64. */
  readonly payload: string;
  /** 올린 시각(ISO). 진단용이다. */
  readonly uploadedAt: string;
}

/**
 * 우리가 올려 둔 사본을 찾는다. 없으면 null.
 *
 * 짝은 **케이스 번호 + 파일 이름**으로 맞춘다. 포털에서 수집한 attachments 행에는 우리
 * 작업 행을 가리키는 것이 아무것도 없다 — document_id 는 Broadcom 이 매기고, 우리는 올릴
 * 때 그 번호를 돌려받지 않는다. 남는 단서가 케이스와 이름뿐이다.
 *
 * **같은 이름이 여러 번 올라갔으면 가장 최근 것을 준다.** 이름만으로는 두 업로드를 가를
 * 수 없기 때문이다. 최근 것을 고르는 이유: 같은 이름을 다시 올리는 일은 보통 "고쳐서 다시
 * 보냄" 이고, 사람이 찾는 것도 그 최신본이다. 옛 판본을 정확히 되찾아야 한다면 이 짝
 * 맞추기로는 안 된다 — 올릴 때 document_id 를 받아 적어야 하고, 지금 경로로는 그 번호가
 * 오지 않는다.
 *
 * payload 가 빈 행은 건너뛴다. 실패한 업로드이거나 이미 치워진 행이고, 둘 다 사본이 아니다.
 */
export async function findKeptUpload(
  db: Db,
  key: { readonly requestId: number; readonly fileName: string },
): Promise<KeptUpload | null> {
  const row = await db.get<{ job_id: number; payload: string; updated_at: string }>(
    `SELECT job_id, payload, updated_at FROM attachment_jobs
      WHERE kind = 'upload' AND state = 'done'
        AND request_id = ? AND file_name = ? AND payload <> ''
      ORDER BY job_id DESC LIMIT 1`,
    [key.requestId, key.fileName],
  );
  if (row === undefined) return null;
  return { jobId: row.job_id, payload: row.payload, uploadedAt: row.updated_at };
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
 * 업로드 보관 기간 — 14일.
 *
 * supportftp 의 files_from_customer 는 투입구라 Broadcom 이 가져가면 비워진다(머리말).
 * 그래서 이 payload 가 우리가 보낸 파일의 유일한 사본이고, 지우면 되돌릴 방법이 없다.
 * 케이스가 오가는 동안 팀원 누구든 다시 받을 수 있도록 2주를 둔다 — 며칠이면 대개 끝나지만
 * 재현 자료를 다시 보내라는 요청이 한 주 뒤에 오는 일이 흔하다.
 *
 * DB 용량 계산: 업로드 상한이 50MB(lib/attachmentUpload.ts)이고 base64 라 1.33배가 붙어
 * 한 건이 최대 약 66.5MB 다. 쓰는 사람이 사내 VPN 안의 소수라 상한 크기를 매일 올리는
 * 그림은 현실적이지 않다. 큰 파일이 **주 2건**이라고 보면 2주에 약 270MB 다.
 *
 * 다만 최악을 적어 두면, 하루 5건을 상한으로 올릴 경우 5 × 66.5MB × 14일 ≈ 4.6GB 다.
 * 상한을 8MB 에서 올렸으므로 이 숫자도 6배가 됐다. **첨부가 늘면 여기가 먼저 아프다.**
 * 그때는 기간을 줄이거나 파일을 DB 밖(오브젝트 스토리지)으로 빼야 한다 — DB 를 첨부
 * 저장소로 키우지는 않는다.
 */
export const UPLOAD_KEEP_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * 다운로드 보관 기간 — 24시간.
 *
 * 남의 파일을 잠깐 받아 둔 임시본이다. 사람은 이미 저장해 갔고, 원본은 supportftp 에
 * 그대로 있으니 다시 필요하면 다시 요청하면 된다(브라우저로 6초). 여기서 지워도 잃는 것이
 * 없으므로 업로드처럼 길게 둘 이유가 없다.
 */
export const DOWNLOAD_KEEP_MS = 24 * 60 * 60 * 1000;

/** 보관 기간을 덮어쓸 때(테스트·운영 조정). 안 주면 위 기본값을 쓴다. */
export interface PurgeWindows {
  readonly uploadMs?: number;
  readonly downloadMs?: number;
}

/**
 * 오래된 일을 지운다. 수집기 회차마다 돈다(collector/attachments.ts).
 *
 * 보관 기간을 **종류별로 다르게** 잡는다. 하나로 묶으면 둘 중 하나가 반드시 틀린다 —
 * 짧게 잡으면 우리가 보낸 파일의 유일한 사본을 잃고, 길게 잡으면 다시 받으면 되는 남의
 * 파일을 2주씩 들고 있는다. 왜 14일과 24시간인지는 UPLOAD_KEEP_MS·DOWNLOAD_KEEP_MS 주석에.
 *
 * 지운 건수를 돌려준다.
 */
export async function purgeOldJobs(db: Db, windows: PurgeWindows = {}): Promise<number> {
  const uploadCutoff = new Date(Date.now() - (windows.uploadMs ?? UPLOAD_KEEP_MS)).toISOString();
  const downloadCutoff = new Date(
    Date.now() - (windows.downloadMs ?? DOWNLOAD_KEEP_MS),
  ).toISOString();

  // 두 기준을 한 조건에 담는다. 종류별로 따로 지우면 회차마다 쿼리가 배로 는다.
  // kind 는 upload | download 뿐이지만 <> 로 써 둔다 — 종류가 늘어도 기본이 짧은 쪽이 된다.
  const where =
    "state IN ('done','failed') AND (" +
    "(kind = 'upload' AND updated_at < ?) OR (kind <> 'upload' AND updated_at < ?))";
  const old = (await db.all<{ job_id: number }>(
    `SELECT job_id FROM attachment_jobs WHERE ${where}`,
    [uploadCutoff, downloadCutoff],
  )) as Array<{ job_id: number }>;
  if (old.length === 0) return 0;
  await db.run(`DELETE FROM attachment_jobs WHERE ${where}`, [uploadCutoff, downloadCutoff]);
  return old.length;
}
