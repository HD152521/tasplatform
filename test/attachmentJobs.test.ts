/**
 * 첨부 작업 큐.
 *
 * 웹과 수집기가 이 테이블로만 이야기한다. 틀리면 겉으로 조용하다 — 버튼을 눌러도
 * 아무 일도 없거나, 같은 일이 두 번 돌거나, 영원히 "처리 중" 으로 남는다.
 *
 * 실제 케이스 번호·파일명은 쓰지 않는다. 이 저장소는 공개이다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../lib/db.ts";
import {
  claimNextJob,
  enqueueDownload,
  enqueueUpload,
  finishJob,
  getJobPayload,
  getJobStatus,
  hasPendingJobs,
  purgeOldJobs,
  reviveStuckJobs,
} from "../lib/attachmentJobs.ts";

const CASE = 20000001;   // 자리표시자
const DOC = 30000001;    // 자리표시자

async function freshDb(): Promise<Db> {
  return openDb(join(mkdtempSync(join(tmpdir(), "attjobs-")), "sr.db"));
}

test("비어 있으면 집을 일이 없다", async () => {
  const db = await freshDb();
  assert.equal(await hasPendingJobs(db), false);
  assert.equal(await claimNextJob(db), null);
  await db.close();
});

test("올릴 파일을 넣고 집어 온다", async () => {
  const db = await freshDb();
  const id = await enqueueUpload(db, { requestId: CASE, fileName: "note.txt", payload: "aGk=" });
  assert.ok(id > 0);
  assert.equal(await hasPendingJobs(db), true);

  const job = await claimNextJob(db);
  assert.equal(job?.job_id, id);
  assert.equal(job?.kind, "upload");
  assert.equal(job?.payload, "aGk=", "올릴 내용이 함께 와야 한다");
  assert.equal(job?.state, "running");
  await db.close();
});

// 집어간 일을 또 집으면 같은 파일이 두 번 올라간다.
test("집어간 일은 다시 집히지 않는다", async () => {
  const db = await freshDb();
  await enqueueUpload(db, { requestId: CASE, fileName: "a.txt", payload: "eA==" });
  await claimNextJob(db);
  assert.equal(await claimNextJob(db), null);
  assert.equal(await hasPendingJobs(db), false);
  await db.close();
});

test("넣은 순서대로 집는다", async () => {
  const db = await freshDb();
  const first = await enqueueUpload(db, { requestId: CASE, fileName: "1.txt", payload: "MQ==" });
  const second = await enqueueUpload(db, { requestId: CASE, fileName: "2.txt", payload: "Mg==" });
  assert.equal((await claimNextJob(db))?.job_id, first);
  assert.equal((await claimNextJob(db))?.job_id, second);
  await db.close();
});

// 브라우저 한 번 띄우는 데 10초다. 여러 번 눌렀다고 여러 번 띄우면 안 된다.
test("같은 첨부를 여러 번 요청해도 일은 하나다", async () => {
  const db = await freshDb();
  const first = await enqueueDownload(db, { requestId: CASE, documentId: DOC, fileName: "a.log" });
  const again = await enqueueDownload(db, { requestId: CASE, documentId: DOC, fileName: "a.log" });
  assert.equal(again, first);

  // 처리 중이어도 마찬가지다.
  await claimNextJob(db);
  assert.equal(await enqueueDownload(db, { requestId: CASE, documentId: DOC, fileName: "a.log" }), first);
  await db.close();
});

test("끝난 뒤에는 다시 요청할 수 있다", async () => {
  const db = await freshDb();
  const first = await enqueueDownload(db, { requestId: CASE, documentId: DOC, fileName: "a.log" });
  await claimNextJob(db);
  await finishJob(db, first, { payload: "ZGF0YQ==" });

  const second = await enqueueDownload(db, { requestId: CASE, documentId: DOC, fileName: "a.log" });
  assert.notEqual(second, first, "끝난 일을 재사용하면 옛 내용을 돌려주게 된다");
  await db.close();
});

test("다른 첨부는 각각 일이 된다", async () => {
  const db = await freshDb();
  const a = await enqueueDownload(db, { requestId: CASE, documentId: DOC, fileName: "a.log" });
  const b = await enqueueDownload(db, { requestId: CASE, documentId: DOC + 1, fileName: "b.log" });
  assert.notEqual(a, b);
  await db.close();
});

/* ------------------------------------------------------------------ *
 * 끝내기
 * ------------------------------------------------------------------ */

test("받아 온 내용을 담고 done 이 된다", async () => {
  const db = await freshDb();
  const id = await enqueueDownload(db, { requestId: CASE, documentId: DOC, fileName: "a.log" });
  await claimNextJob(db);
  await finishJob(db, id, { payload: "ZGF0YQ==" });

  assert.equal((await getJobStatus(db, id))?.state, "done");
  assert.equal((await getJobPayload(db, id))?.payload, "ZGF0YQ==");
  await db.close();
});

// 이미 올린 파일을 DB 에 들고 있을 이유가 없다.
test("업로드가 끝나면 올릴 내용을 비운다", async () => {
  const db = await freshDb();
  const id = await enqueueUpload(db, { requestId: CASE, fileName: "a.txt", payload: "aGVsbG8=" });
  await claimNextJob(db);
  await finishJob(db, id, {});

  assert.equal((await getJobPayload(db, id))?.payload, "", "올린 뒤에는 비어야 한다");
  assert.equal((await getJobStatus(db, id))?.state, "done");
  await db.close();
});

test("실패는 사유와 함께 남는다", async () => {
  const db = await freshDb();
  const id = await enqueueUpload(db, { requestId: CASE, fileName: "a.txt", payload: "eA==" });
  await claimNextJob(db);
  await finishJob(db, id, { error: "첨부 서버가 거부했습니다" });

  const status = await getJobStatus(db, id);
  assert.equal(status?.state, "failed");
  assert.match(status?.error ?? "", /거부/);
  await db.close();
});

// 상태만 보는데 큰 내용을 끌고 오면 목록이 느려진다.
test("상태 조회는 내용을 가져오지 않는다", async () => {
  const db = await freshDb();
  const id = await enqueueUpload(db, { requestId: CASE, fileName: "a.txt", payload: "bG9uZw==" });
  assert.equal((await getJobStatus(db, id))?.payload, "");
  assert.equal((await getJobPayload(db, id))?.payload, "bG9uZw==");
  await db.close();
});

/* ------------------------------------------------------------------ *
 * 되살리기 · 치우기
 *
 * worker 가 처리 중에 죽으면 running 인 행이 남고, 아무도 끝내주지 않는다.
 * 되살리지 않으면 사람은 영원히 "처리 중" 만 본다.
 * ------------------------------------------------------------------ */

test("오래 멈춘 일은 다시 줄에 세운다", async () => {
  const db = await freshDb();
  const id = await enqueueUpload(db, { requestId: CASE, fileName: "a.txt", payload: "eA==" });
  await claimNextJob(db);
  // 15분 전에 집어간 것으로 만든다.
  await db.run("UPDATE attachment_jobs SET updated_at = ? WHERE job_id = ?", ["2000-01-01T00:00:00.000Z", id]);

  assert.equal(await reviveStuckJobs(db), 1);
  assert.equal((await getJobStatus(db, id))?.state, "pending");
  assert.equal((await claimNextJob(db))?.job_id, id, "다시 집을 수 있어야 한다");
  await db.close();
});

test("방금 집어간 일은 건드리지 않는다", async () => {
  const db = await freshDb();
  await enqueueUpload(db, { requestId: CASE, fileName: "a.txt", payload: "eA==" });
  await claimNextJob(db);
  assert.equal(await reviveStuckJobs(db), 0, "처리 중인 일을 뺏으면 같은 파일이 두 번 올라간다");
  await db.close();
});

test("끝난 지 오래된 일은 지운다", async () => {
  const db = await freshDb();
  const id = await enqueueDownload(db, { requestId: CASE, documentId: DOC, fileName: "a.log" });
  await claimNextJob(db);
  await finishJob(db, id, { payload: "ZGF0YQ==" });
  await db.run("UPDATE attachment_jobs SET updated_at = ? WHERE job_id = ?", ["2000-01-01T00:00:00.000Z", id]);

  assert.equal(await purgeOldJobs(db), 1);
  assert.equal(await getJobStatus(db, id), null);
  await db.close();
});

test("아직 안 끝난 일은 지우지 않는다", async () => {
  const db = await freshDb();
  const id = await enqueueUpload(db, { requestId: CASE, fileName: "a.txt", payload: "eA==" });
  await db.run("UPDATE attachment_jobs SET updated_at = ? WHERE job_id = ?", ["2000-01-01T00:00:00.000Z", id]);
  assert.equal(await purgeOldJobs(db), 0, "대기 중인 일을 지우면 사람이 기다리다 만다");
  await db.close();
});
