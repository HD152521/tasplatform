/**
 * SR ↔ Jira 티켓 연결.
 *
 * 이 표가 두 가지를 받친다 — **어디에 댓글을 달지**, 그리고 **자동 게시의 울타리**
 * (이 행이 있는 SR 만 대상이다). 틀리면 과거 SR 이 자동 대상에 섞이거나 같은 티켓에
 * 댓글이 두 번 달린다.
 *
 * 실제 케이스 번호는 쓰지 않는다 — 이 저장소는 공개다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../lib/db.ts";
import {
  getSrJiraLink, markSrJiraCommented, saveSrJiraLink,
} from "../lib/jiraLinkStore.ts";

const CASE = 20000001;   // 자리표시자

async function freshDb(): Promise<Db> {
  return openDb(join(mkdtempSync(join(tmpdir(), "jiralink-")), "sr.db"));
}

test("남긴 연결을 그대로 돌려준다", async () => {
  const db = await freshDb();
  await saveSrJiraLink(db, {
    requestId: CASE, issueKey: "PRJ-1", issueUrl: "https://jira.test/browse/PRJ-1",
    track: "운영", titleKo: "한글 제목",
  });
  const link = await getSrJiraLink(db, CASE);
  assert.equal(link?.issueKey, "PRJ-1");
  assert.equal(link?.issueUrl, "https://jira.test/browse/PRJ-1");
  assert.equal(link?.track, "운영");
  assert.equal(link?.titleKo, "한글 제목", "Postgres 소문자 접힘에 걸리는 자리다");
  assert.equal(link?.commentedAt, "", "아직 댓글을 달지 않았다");
  assert.ok((link?.createdAt ?? "") !== "");
  await db.close();
});

test("없으면 null 이다", async () => {
  const db = await freshDb();
  assert.equal(await getSrJiraLink(db, CASE), null);
  await db.close();
});

/*
 * 한 SR 에 티켓은 하나다. 행이 둘 생기면 댓글을 어디에 달지 알 수 없다.
 */
test("같은 SR 로 두 번 넣으면 덮어쓴다", async () => {
  const db = await freshDb();
  await saveSrJiraLink(db, { requestId: CASE, issueKey: "PRJ-1" });
  await saveSrJiraLink(db, { requestId: CASE, issueKey: "PRJ-2", track: "개발" });
  const link = await getSrJiraLink(db, CASE);
  assert.equal(link?.issueKey, "PRJ-2");
  assert.equal(link?.track, "개발");
  await db.close();
});

/*
 * 댓글 표시가 **곧 자물쇠**다. 자동 게시는 조건으로 대상을 고르므로(스스로 낫는 구조),
 * 표시가 없으면 다음 회차가 같은 티켓에 같은 댓글을 또 단다.
 */
test("댓글 표시를 남기면 시각이 찍힌다", async () => {
  const db = await freshDb();
  await saveSrJiraLink(db, { requestId: CASE, issueKey: "PRJ-1" });
  await markSrJiraCommented(db, CASE);
  const link = await getSrJiraLink(db, CASE);
  assert.notEqual(link?.commentedAt, "", "표시가 남지 않았다");
  await db.close();
});

// 덮어써도 댓글 표시는 지워지지 않아야 한다 — 지워지면 댓글이 두 번 달린다.
test("덮어써도 댓글 표시는 남는다", async () => {
  const db = await freshDb();
  await saveSrJiraLink(db, { requestId: CASE, issueKey: "PRJ-1" });
  await markSrJiraCommented(db, CASE);
  await saveSrJiraLink(db, { requestId: CASE, issueKey: "PRJ-1", titleKo: "고친 제목" });
  const link = await getSrJiraLink(db, CASE);
  assert.notEqual(link?.commentedAt, "", "표시가 지워졌다 — 댓글이 두 번 달린다");
  assert.equal(link?.titleKo, "고친 제목");
  await db.close();
});

test("비워 둔 칸은 빈 문자열이다", async () => {
  const db = await freshDb();
  await saveSrJiraLink(db, { requestId: CASE, issueKey: "PRJ-1" });
  const link = await getSrJiraLink(db, CASE);
  assert.equal(link?.issueUrl, "");
  assert.equal(link?.track, "");
  assert.equal(link?.titleKo, "");
  await db.close();
});
