/**
 * 첨부 작업 큐를 **팀별로** 집는 부분.
 *
 * ## 왜 이것이 안전 문제인가
 *
 * 첨부를 올리는 것은 그 팀의 브로드컴 계정으로 포털에 들어가는 일이다. 한 세션으로
 * 전부 올리면 **2번 팀 고객 파일이 1번 팀 계정으로** 올라간다 — 고객 자료가 남의 계정
 * 이름으로 상대에게 전달되는 것이고, 되돌릴 수 없다.
 *
 * 그래서 두 가지를 잠근다.
 *   - `pendingTeams` 가 일이 남은 팀을 빠뜨리지 않는다(빠지면 그 팀 파일이 안 올라간다).
 *   - `claimNextJobForTeam` 이 **남의 팀 일을 집지 않는다**(집으면 위 사고가 난다).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  claimNextJobForTeam,
  enqueueUpload,
  pendingTeams,
} from "../lib/attachmentJobs.ts";
import { openDb, type Db } from "../lib/db.ts";

function freshDb(): Promise<Db> {
  return openDb(join(mkdtempSync(join(tmpdir(), "attteam-")), "sr.db"));
}

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

/** 그 팀의 업로드 작업 하나. */
async function queue(teamId: string, fileName: string): Promise<number> {
  return enqueueUpload(db, {
    requestId: 1,
    fileName,
    payload: "AAAA",
    actor: "tester",
    teamId,
  });
}

test("일이 남은 팀만 돌려준다", async () => {
  await queue("default", "a.txt");
  await queue("team-b", "b.txt");
  assert.deepEqual(await pendingTeams(db), ["default", "team-b"]);
});

test("일이 없으면 빈 목록이다", async () => {
  assert.deepEqual(await pendingTeams(db), []);
});

test("같은 팀 일이 여러 건이어도 한 번만 센다", async () => {
  await queue("team-b", "a.txt");
  await queue("team-b", "b.txt");
  assert.deepEqual(await pendingTeams(db), ["team-b"]);
});

test("옛 행(팀 없음)은 기본 팀으로 본다", async () => {
  // team_id 칸이 생기기 전 행은 빈 문자열이다. 빠뜨리면 그 파일이 영원히 안 올라간다.
  await queue("default", "a.txt");
  await db.run("UPDATE attachment_jobs SET team_id = '' WHERE file_name = 'a.txt'");
  assert.deepEqual(await pendingTeams(db), ["default"]);
});

test("남의 팀 일을 집지 않는다", async () => {
  const mine = await queue("default", "ours.txt");
  const theirs = await queue("team-b", "theirs.txt");

  const first = await claimNextJobForTeam(db, "team-b");
  assert.equal(first?.job_id, theirs, "그 팀 일만 집어야 한다");
  assert.equal(first?.file_name, "theirs.txt");

  // 그 팀에는 더 집을 것이 없다 — 우리 팀 일이 남아 있어도.
  assert.equal(await claimNextJobForTeam(db, "team-b"), null);

  const ours = await claimNextJobForTeam(db, "default");
  assert.equal(ours?.job_id, mine);
});

test("기본 팀은 옛 행(팀 없음)까지 함께 집는다", async () => {
  const legacy = await queue("default", "legacy.txt");
  await db.run("UPDATE attachment_jobs SET team_id = '' WHERE job_id = ?", [legacy]);

  const got = await claimNextJobForTeam(db, "default");
  assert.equal(got?.job_id, legacy);
});

test("다른 팀은 옛 행을 집지 않는다", async () => {
  // 빈 team_id 는 기본 팀 것이다. 2번 팀이 집으면 1번 팀 파일을 2번 팀 계정으로 올린다.
  const legacy = await queue("default", "legacy.txt");
  await db.run("UPDATE attachment_jobs SET team_id = '' WHERE job_id = ?", [legacy]);

  assert.equal(await claimNextJobForTeam(db, "team-b"), null);
});

test("집은 일은 running 이 되어 두 번 집히지 않는다", async () => {
  await queue("team-b", "a.txt");
  const first = await claimNextJobForTeam(db, "team-b");
  assert.ok(first !== null);
  assert.equal(first.state, "running");
  assert.equal(await claimNextJobForTeam(db, "team-b"), null);
});

test("먼저 들어온 일을 먼저 집는다", async () => {
  const a = await queue("team-b", "a.txt");
  const b = await queue("team-b", "b.txt");
  assert.equal((await claimNextJobForTeam(db, "team-b"))?.job_id, a);
  assert.equal((await claimNextJobForTeam(db, "team-b"))?.job_id, b);
});
