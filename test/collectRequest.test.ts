/**
 * "지금 수집" 요청을 웹 → 수집기로 넘기는 것.
 *
 * 두 기계가 공유 DB 로만 이야기한다. 여기가 틀리면 둘 중 하나로 망가지는데, 둘 다
 * 겉으로는 조용하다 — 버튼을 눌러도 아무 일도 안 일어나거나, 한 번 누른 요청으로
 * 수집이 계속 돌아 Broadcom 에 쓸데없는 요청을 보낸다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../lib/db.ts";
import {
  markCollectHandled,
  pendingCollectRequest,
  requestCollect,
} from "../lib/collectRequest.ts";

async function freshDb(): Promise<Db> {
  return openDb(join(mkdtempSync(join(tmpdir(), "collectreq-")), "sr.db"));
}

test("아무도 누르지 않았으면 대기 중인 요청이 없다", async () => {
  const db = await freshDb();
  assert.equal(await pendingCollectRequest(db), null);
  await db.close();
});

test("누르면 대기 중인 요청이 생긴다", async () => {
  const db = await freshDb();
  const at = await requestCollect(db);
  assert.equal(await pendingCollectRequest(db), at);
  await db.close();
});

// 여기가 틀리면 한 번 누른 요청으로 수집이 계속 돈다.
test("집어간 뒤에는 다시 집히지 않는다", async () => {
  const db = await freshDb();
  const at = await requestCollect(db);
  await markCollectHandled(db, at);
  assert.equal(await pendingCollectRequest(db), null);
  await db.close();
});

// 여러 번 눌러도 한 회차가 전부를 만족시킨다 — 큐를 두지 않는 이유.
test("여러 번 눌러도 요청은 하나로 합쳐진다", async () => {
  const db = await freshDb();
  await requestCollect(db);
  await requestCollect(db);
  const last = await requestCollect(db);

  assert.equal(await pendingCollectRequest(db), last);
  await markCollectHandled(db, last);
  assert.equal(await pendingCollectRequest(db), null, "한 회차로 세 번의 요청이 끝나야");
  await db.close();
});

// 수집이 도는 동안 사람이 또 누른 경우. 그 요청은 남아 다음 회차로 가야 한다 —
// 안 그러면 방금 올린 답변이 반영되지 않은 채 "끝났다" 가 된다.
test("처리 중에 들어온 요청은 남는다", async () => {
  const db = await freshDb();
  const first = await requestCollect(db);
  await markCollectHandled(db, first);   // 수집기가 집어가 회차를 시작

  const second = await requestCollect(db); // 그 사이에 또 누름
  assert.equal(await pendingCollectRequest(db), second);
  await db.close();
});

test("처리 표시가 더 뒤면 오래된 요청은 집히지 않는다", async () => {
  const db = await freshDb();
  const at = await requestCollect(db);
  // 실제로는 같은 값을 찍지만, 뒤 시각으로 찍혀도 대기로 남지 않아야 한다.
  await markCollectHandled(db, "2099-01-01T00:00:00.000Z");
  assert.notEqual(at, "");
  assert.equal(await pendingCollectRequest(db), null);
  await db.close();
});
