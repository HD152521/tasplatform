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
  DOWNLOAD_KEEP_MS,
  UPLOAD_KEEP_MS,
  claimNextJob,
  enqueueDownload,
  enqueueUpload,
  findKeptUpload,
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

/** 그 일을 `ms` 만큼 전에 끝난 것으로 만든다. 보관 기간 판정은 updated_at 으로 한다. */
async function ageJob(db: Db, jobId: number, ms: number): Promise<void> {
  await db.run("UPDATE attachment_jobs SET updated_at = ? WHERE job_id = ?", [
    new Date(Date.now() - ms).toISOString(),
    jobId,
  ]);
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

// 이게 깨지면 우리가 보낸 파일을 우리가 다시 받을 방법이 사라진다.
// supportftp 의 files_from_customer 는 투입구라 Broadcom 이 가져가면 비워지고,
// 그러면 이 payload 가 유일한 사본이다.
test("업로드가 끝나도 올린 내용은 남는다", async () => {
  const db = await freshDb();
  const id = await enqueueUpload(db, { requestId: CASE, fileName: "a.txt", payload: "aGVsbG8=" });
  await claimNextJob(db);
  // 수집기는 업로드 성공에서 payload 를 싣지 않는다(collector/attachments.ts). 그대로 흉내 낸다.
  await finishJob(db, id, {});

  assert.equal((await getJobPayload(db, id))?.payload, "aGVsbG8=", "올린 뒤에도 사본이 남아야 한다");
  assert.equal((await getJobStatus(db, id))?.state, "done");
  await db.close();
});

// 보낸 적이 없으니 사본이라 부를 것이 없다. 올라가지도 않은 바이트를 2주 들고 있으면
// DB 만 부푼다.
test("업로드가 실패하면 올릴 내용을 비운다", async () => {
  const db = await freshDb();
  const id = await enqueueUpload(db, { requestId: CASE, fileName: "a.txt", payload: "aGVsbG8=" });
  await claimNextJob(db);
  await finishJob(db, id, { error: "첨부 서버가 거부했습니다" });

  assert.equal((await getJobPayload(db, id))?.payload, "", "실패한 업로드는 비워야 한다");
  assert.equal((await getJobStatus(db, id))?.state, "failed");
  await db.close();
});

// 받아오지 못했으면 담을 것도 없다.
test("다운로드가 실패하면 받아 둔 내용이 없다", async () => {
  const db = await freshDb();
  const id = await enqueueDownload(db, { requestId: CASE, documentId: DOC, fileName: "a.log" });
  await claimNextJob(db);
  await finishJob(db, id, { error: "이 첨부는 서버에서 삭제되었습니다" });

  assert.equal((await getJobPayload(db, id))?.payload, "");
  assert.equal((await getJobStatus(db, id))?.state, "failed");
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
  await ageJob(db, id, 30 * 24 * 60 * 60 * 1000);

  assert.equal(await purgeOldJobs(db), 1);
  assert.equal(await getJobStatus(db, id), null);
  await db.close();
});

test("아직 안 끝난 일은 지우지 않는다", async () => {
  const db = await freshDb();
  const id = await enqueueUpload(db, { requestId: CASE, fileName: "a.txt", payload: "eA==" });
  await ageJob(db, id, 30 * 24 * 60 * 60 * 1000);
  assert.equal(await purgeOldJobs(db), 0, "대기 중인 일을 지우면 사람이 기다리다 만다");
  await db.close();
});

/* ------------------------------------------------------------------ *
 * 보관 기간은 종류별로 다르다
 *
 * 업로드 payload 는 우리가 보낸 파일의 유일한 사본이라 14일, 다운로드는 다시 받으면
 * 되는 임시본이라 24시간이다. 한 값으로 묶으면 둘 중 하나가 반드시 틀린다 — 짧게 잡으면
 * 보낸 파일을 잃고, 길게 잡으면 남의 파일을 쓸데없이 2주 들고 있는다.
 * ------------------------------------------------------------------ */

test("업로드는 다운로드 기간이 지나도 남는다", async () => {
  const db = await freshDb();
  const upload = await enqueueUpload(db, { requestId: CASE, fileName: "a.txt", payload: "aGk=" });
  await claimNextJob(db);
  await finishJob(db, upload, {});
  const download = await enqueueDownload(db, { requestId: CASE, documentId: DOC, fileName: "b.log" });
  await claimNextJob(db);
  await finishJob(db, download, { payload: "ZGF0YQ==" });

  // 둘 다 이틀 전. 다운로드 기간(24시간)은 넘었고 업로드 기간(14일)은 안 넘었다.
  const twoDays = 2 * 24 * 60 * 60 * 1000;
  await ageJob(db, upload, twoDays);
  await ageJob(db, download, twoDays);

  assert.equal(await purgeOldJobs(db), 1, "다운로드만 지워져야 한다");
  assert.equal((await getJobPayload(db, upload))?.payload, "aGk=", "우리가 보낸 사본이 남아야 한다");
  assert.equal(await getJobStatus(db, download), null);
  await db.close();
});

// 남의 파일을 잠깐 받아 둔 임시본이다. 하루가 지나면 내용까지 지운다.
test("다운로드는 24시간이 지나면 받아 둔 내용까지 지운다", async () => {
  const db = await freshDb();
  const id = await enqueueDownload(db, { requestId: CASE, documentId: DOC, fileName: "a.log" });
  await claimNextJob(db);
  await finishJob(db, id, { payload: "ZGF0YQ==" });

  await ageJob(db, id, DOWNLOAD_KEEP_MS - 60_000);
  assert.equal(await purgeOldJobs(db), 0, "방금 받아 둔 것을 지우면 사람이 다시 기다린다");

  await ageJob(db, id, DOWNLOAD_KEEP_MS + 60_000);
  assert.equal(await purgeOldJobs(db), 1);
  assert.equal(await getJobStatus(db, id), null);
  await db.close();
});

test("업로드도 14일이 지나면 지운다", async () => {
  const db = await freshDb();
  const id = await enqueueUpload(db, { requestId: CASE, fileName: "a.txt", payload: "aGk=" });
  await claimNextJob(db);
  await finishJob(db, id, {});

  await ageJob(db, id, UPLOAD_KEEP_MS - 60_000);
  assert.equal(await purgeOldJobs(db), 0, "14일 안쪽은 남겨야 한다");

  await ageJob(db, id, UPLOAD_KEEP_MS + 60_000);
  assert.equal(await purgeOldJobs(db), 1, "DB 를 첨부 저장소로 키우지 않는다");
  await db.close();
});

test("보관 기간을 인자로 덮어쓸 수 있다", async () => {
  const db = await freshDb();
  const id = await enqueueUpload(db, { requestId: CASE, fileName: "a.txt", payload: "aGk=" });
  await claimNextJob(db);
  await finishJob(db, id, {});
  await ageJob(db, id, 2 * DOWNLOAD_KEEP_MS);

  assert.equal(await purgeOldJobs(db, { uploadMs: 10 * DOWNLOAD_KEEP_MS }), 0);
  assert.equal(await purgeOldJobs(db, { uploadMs: DOWNLOAD_KEEP_MS }), 1);
  await db.close();
});

/* ------------------------------------------------------------------ *
 * 우리 사본 찾기
 *
 * 이게 없으면 우리가 올린 첨부를 누를 때마다 수집기가 브라우저를 띄우고, 수십 초 뒤에
 * "서버에서 삭제되었습니다" 만 돌려준다 — 사본을 들고 있는데도.
 * ------------------------------------------------------------------ */

test("올려 둔 사본을 케이스와 이름으로 찾는다", async () => {
  const db = await freshDb();
  const id = await enqueueUpload(db, { requestId: CASE, fileName: "a.txt", payload: "aGk=" });
  await claimNextJob(db);
  await finishJob(db, id, {});

  const kept = await findKeptUpload(db, { requestId: CASE, fileName: "a.txt" });
  assert.equal(kept?.jobId, id);
  assert.equal(kept?.payload, "aGk=");
  assert.ok((kept?.uploadedAt ?? "") !== "");
  await db.close();
});

test("이름이나 케이스가 다르면 찾지 않는다", async () => {
  const db = await freshDb();
  const id = await enqueueUpload(db, { requestId: CASE, fileName: "a.txt", payload: "aGk=" });
  await claimNextJob(db);
  await finishJob(db, id, {});

  assert.equal(await findKeptUpload(db, { requestId: CASE, fileName: "b.txt" }), null);
  assert.equal(
    await findKeptUpload(db, { requestId: CASE + 1, fileName: "a.txt" }),
    null,
    "남의 케이스 첨부를 우리 사본으로 내려주면 안 된다",
  );
  await db.close();
});

// 이름만으로는 두 업로드를 가를 수 없다. 최신본을 고른다 — 같은 이름을 다시 올리는 일은
// 보통 "고쳐서 다시 보냄" 이고, 사람이 찾는 것도 그 최신본이다.
test("같은 이름이 여러 번 올라갔으면 가장 최근 것을 준다", async () => {
  const db = await freshDb();
  const older = await enqueueUpload(db, { requestId: CASE, fileName: "a.txt", payload: "b2xk" });
  await claimNextJob(db);
  await finishJob(db, older, {});
  const newer = await enqueueUpload(db, { requestId: CASE, fileName: "a.txt", payload: "bmV3" });
  await claimNextJob(db);
  await finishJob(db, newer, {});

  const kept = await findKeptUpload(db, { requestId: CASE, fileName: "a.txt" });
  assert.equal(kept?.jobId, newer);
  assert.equal(kept?.payload, "bmV3");
  await db.close();
});

test("아직 안 끝난 업로드는 사본으로 쓰지 않는다", async () => {
  const db = await freshDb();
  await enqueueUpload(db, { requestId: CASE, fileName: "a.txt", payload: "aGk=" });
  assert.equal(
    await findKeptUpload(db, { requestId: CASE, fileName: "a.txt" }),
    null,
    "올라가지도 않은 파일을 올린 것처럼 내려주면 안 된다",
  );
  await db.close();
});

test("실패한 업로드는 사본으로 쓰지 않는다", async () => {
  const db = await freshDb();
  const id = await enqueueUpload(db, { requestId: CASE, fileName: "a.txt", payload: "aGk=" });
  await claimNextJob(db);
  await finishJob(db, id, { error: "첨부 서버가 거부했습니다" });
  assert.equal(await findKeptUpload(db, { requestId: CASE, fileName: "a.txt" }), null);
  await db.close();
});

test("다운로드로 받아 둔 것은 우리 사본이 아니다", async () => {
  const db = await freshDb();
  const id = await enqueueDownload(db, { requestId: CASE, documentId: DOC, fileName: "a.log" });
  await claimNextJob(db);
  await finishJob(db, id, { payload: "ZGF0YQ==" });
  assert.equal(
    await findKeptUpload(db, { requestId: CASE, fileName: "a.log" }),
    null,
    "받아 둔 임시본은 24시간이면 사라진다 — 사본으로 셈하면 곧 없는 것을 약속하는 셈이다",
  );
  await db.close();
});

test("치워진 뒤에는 사본이 없다", async () => {
  const db = await freshDb();
  const id = await enqueueUpload(db, { requestId: CASE, fileName: "a.txt", payload: "aGk=" });
  await claimNextJob(db);
  await finishJob(db, id, {});
  await ageJob(db, id, UPLOAD_KEEP_MS + 60_000);
  await purgeOldJobs(db);

  assert.equal(await findKeptUpload(db, { requestId: CASE, fileName: "a.txt" }), null);
  await db.close();
});
