/**
 * "지금 수집" 요청을 웹 → 수집기로 넘기는 것.
 *
 * 두 기계가 공유 DB 로만 이야기한다. 여기가 틀리면 둘 중 하나로 망가지는데, 둘 다
 * 겉으로는 조용하다 — 버튼을 눌러도 아무 일도 안 일어나거나, 한 번 누른 요청으로
 * 수집이 계속 돌아 Broadcom 에 쓸데없는 요청을 보낸다.
 *
 * 처음에는 시각(ISO)을 비교했고 리눅스 CI 에서 깨졌다. 밀리초까지밖에 없어서 빠른
 * 기계에서는 "집어감 → 또 누름" 이 같은 밀리초에 일어나 새 요청이 삼켜졌다. 지금은
 * 번호로 비교하므로 시계와 무관하다 — 그 성질을 아래에서 직접 잰다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../lib/db.ts";
import {
  isCollectHandled,
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

test("누르면 대기 중인 요청이 생기고 번호는 1부터다", async () => {
  const db = await freshDb();
  const first = await requestCollect(db);
  assert.equal(first.seq, 1);
  assert.equal(await pendingCollectRequest(db), 1);
  await db.close();
});

// 여기가 틀리면 한 번 누른 요청으로 수집이 계속 돈다.
test("집어간 뒤에는 다시 집히지 않는다", async () => {
  const db = await freshDb();
  const request = await requestCollect(db);
  await markCollectHandled(db, request.seq);
  assert.equal(await pendingCollectRequest(db), null);
  await db.close();
});

// 여러 번 눌러도 한 회차가 전부를 만족시킨다 — 큐를 두지 않는 이유.
test("여러 번 눌러도 요청은 하나로 합쳐진다", async () => {
  const db = await freshDb();
  await requestCollect(db);
  await requestCollect(db);
  const last = await requestCollect(db);
  assert.equal(last.seq, 3);

  assert.equal(await pendingCollectRequest(db), 3);
  await markCollectHandled(db, last.seq);
  assert.equal(await pendingCollectRequest(db), null, "한 회차로 세 번의 요청이 끝나야");
  await db.close();
});

/*
 * 이 테스트가 리눅스 CI 에서 실패해 설계 결함을 잡았다.
 *
 *   expected '2026-09-28T06:04:23.076Z', actual null
 *
 * 시각으로 비교하던 때, 아래 세 줄이 **같은 밀리초** 안에 끝나면 처리 시각 >= 요청 시각
 * 이 되어 두 번째 요청이 사라졌다. 느린 기계에서는 우연히 통과했다.
 * 지금은 번호라 기계 속도와 무관하게 성립한다.
 */
test("처리 중에 들어온 요청은 남는다 (같은 밀리초여도)", async () => {
  const db = await freshDb();
  const first = await requestCollect(db);
  await markCollectHandled(db, first.seq);   // 수집기가 집어가 회차를 시작

  const second = await requestCollect(db);   // 그 사이에 또 누름
  assert.equal(await pendingCollectRequest(db), second.seq);
  assert.equal(second.seq, first.seq + 1, "번호가 올라야 구분된다");
  await db.close();
});

test("이미 처리한 번호를 다시 찍어도 요청이 되살아나지 않는다", async () => {
  const db = await freshDb();
  const first = await requestCollect(db);
  const second = await requestCollect(db);
  await markCollectHandled(db, second.seq);
  await markCollectHandled(db, first.seq);   // 뒤늦게 도착한 옛 표시

  assert.equal(await pendingCollectRequest(db), null, "되돌리면 처리한 요청이 되살아난다");
  await db.close();
});

test("집어갔는지 번호로 물어볼 수 있다", async () => {
  const db = await freshDb();
  const request = await requestCollect(db);
  assert.equal(await isCollectHandled(db, request.seq), false);
  await markCollectHandled(db, request.seq);
  assert.equal(await isCollectHandled(db, request.seq), true);
  await db.close();
});

test("깨진 값이 들어 있어도 터지지 않는다", async () => {
  const db = await freshDb();
  // 사람이 손으로 고쳤거나 옛 형식(ISO 시각)이 남아 있는 경우.
  await db.run(
    "INSERT INTO app_state (key, value, updated_at) VALUES ('collect_requested_seq','2026-09-28T06:04:23.076Z','')",
  );
  assert.equal(await pendingCollectRequest(db), null);

  // 그 뒤에 누르면 1부터 다시 시작한다 — 요청이 사라지지는 않는다.
  const request = await requestCollect(db);
  assert.equal(request.seq, 1);
  assert.equal(await pendingCollectRequest(db), 1);
  await db.close();
});
