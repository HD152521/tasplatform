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
 *
 * 수집기가 셋(케이스·보안 공지·기술 문서)이므로 번호도 셋이다. 그것들이 서로 섞이지
 * 않는다는 것도 함께 잰다 — 섞이면 한쪽 요청이 다른 쪽 회차에 지워진다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAppState } from "../lib/appState.ts";
import { COLLECT_KINDS, parseCollectKind } from "../lib/collectKind.ts";
import { openDb, type Db } from "../lib/db.ts";
import {
  collectOutcome,
  isCollectHandled,
  markCollectFinished,
  markCollectHandled,
  pendingCollectRequest,
  requestCollect,
} from "../lib/collectRequest.ts";

async function freshDb(): Promise<Db> {
  return openDb(join(mkdtempSync(join(tmpdir(), "collectreq-")), "sr.db"));
}

test("아무도 누르지 않았으면 대기 중인 요청이 없다", async () => {
  const db = await freshDb();
  for (const kind of COLLECT_KINDS) {
    assert.equal(await pendingCollectRequest(db, kind), null, kind);
  }
  await db.close();
});

test("누르면 대기 중인 요청이 생기고 번호는 1부터다", async () => {
  const db = await freshDb();
  const first = await requestCollect(db, "cases");
  assert.equal(first.seq, 1);
  assert.equal(await pendingCollectRequest(db, "cases"), 1);
  await db.close();
});

// 여기가 틀리면 한 번 누른 요청으로 수집이 계속 돈다.
test("집어간 뒤에는 다시 집히지 않는다", async () => {
  const db = await freshDb();
  const request = await requestCollect(db, "cases");
  await markCollectHandled(db, "cases", request.seq);
  assert.equal(await pendingCollectRequest(db, "cases"), null);
  await db.close();
});

// 여러 번 눌러도 한 회차가 전부를 만족시킨다 — 큐를 두지 않는 이유.
test("여러 번 눌러도 요청은 하나로 합쳐진다", async () => {
  const db = await freshDb();
  await requestCollect(db, "cases");
  await requestCollect(db, "cases");
  const last = await requestCollect(db, "cases");
  assert.equal(last.seq, 3);

  assert.equal(await pendingCollectRequest(db, "cases"), 3);
  await markCollectHandled(db, "cases", last.seq);
  assert.equal(await pendingCollectRequest(db, "cases"), null, "한 회차로 세 번의 요청이 끝나야");
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
  const first = await requestCollect(db, "cases");
  await markCollectHandled(db, "cases", first.seq);   // 수집기가 집어가 회차를 시작

  const second = await requestCollect(db, "cases");   // 그 사이에 또 누름
  assert.equal(await pendingCollectRequest(db, "cases"), second.seq);
  assert.equal(second.seq, first.seq + 1, "번호가 올라야 구분된다");
  await db.close();
});

test("이미 처리한 번호를 다시 찍어도 요청이 되살아나지 않는다", async () => {
  const db = await freshDb();
  const first = await requestCollect(db, "cases");
  const second = await requestCollect(db, "cases");
  await markCollectHandled(db, "cases", second.seq);
  await markCollectHandled(db, "cases", first.seq);   // 뒤늦게 도착한 옛 표시

  assert.equal(await pendingCollectRequest(db, "cases"), null, "되돌리면 처리한 요청이 되살아난다");
  await db.close();
});

test("집어갔는지 번호로 물어볼 수 있다", async () => {
  const db = await freshDb();
  const request = await requestCollect(db, "cases");
  assert.equal(await isCollectHandled(db, "cases", request.seq), false);
  await markCollectHandled(db, "cases", request.seq);
  assert.equal(await isCollectHandled(db, "cases", request.seq), true);
  await db.close();
});

test("깨진 값이 들어 있어도 터지지 않는다", async () => {
  const db = await freshDb();
  // 사람이 손으로 고쳤거나 옛 형식(ISO 시각)이 남아 있는 경우.
  await db.run(
    "INSERT INTO app_state (key, value, updated_at) VALUES ('collect_requested_seq','2026-09-28T06:04:23.076Z','')",
  );
  assert.equal(await pendingCollectRequest(db, "cases"), null);

  // 그 뒤에 누르면 1부터 다시 시작한다 — 요청이 사라지지는 않는다.
  const request = await requestCollect(db, "cases");
  assert.equal(request.seq, 1);
  assert.equal(await pendingCollectRequest(db, "cases"), 1);
  await db.close();
});

/*
 * 종류별 칸이 섞이지 않는지.
 *
 * 하나라도 섞이면 "보안 공지를 눌렀는데 케이스 수집이 돌고, 정작 보안 공지 요청은
 * 처리됐다고 지워진다". 화면에는 완료만 뜨고 목록은 그대로다.
 */

test("한 종류를 눌러도 다른 종류에는 요청이 생기지 않는다", async () => {
  const db = await freshDb();
  await requestCollect(db, "cves");

  assert.equal(await pendingCollectRequest(db, "cves"), 1);
  assert.equal(await pendingCollectRequest(db, "cases"), null, "케이스 수집이 돌면 안 된다");
  assert.equal(await pendingCollectRequest(db, "kb"), null);
  await db.close();
});

test("한 종류를 집어가도 다른 종류의 요청은 그대로 남는다", async () => {
  const db = await freshDb();
  const cves = await requestCollect(db, "cves");
  const kb = await requestCollect(db, "kb");

  await markCollectHandled(db, "cases", 99);           // 케이스 회차가 크게 앞서 가도
  assert.equal(await pendingCollectRequest(db, "cves"), cves.seq, "남의 처리 표시에 지워지면 안 된다");
  assert.equal(await pendingCollectRequest(db, "kb"), kb.seq);

  await markCollectHandled(db, "cves", cves.seq);
  assert.equal(await pendingCollectRequest(db, "cves"), null);
  assert.equal(await pendingCollectRequest(db, "kb"), kb.seq, "기술 문서 요청까지 끝난 것이 되면 안 된다");
  await db.close();
});

test("종류마다 번호를 따로 센다", async () => {
  const db = await freshDb();
  await requestCollect(db, "cases");
  await requestCollect(db, "cases");
  const cves = await requestCollect(db, "cves");
  assert.equal(cves.seq, 1, "케이스를 두 번 누른 것이 보안 공지 번호를 밀면 안 된다");
  await db.close();
});

/*
 * 이미 배포된 DB 와의 호환.
 *
 * 케이스 칸은 접두사 없는 옛 키 이름을 그대로 쓴다. 웹과 수집기가 따로 재시작되므로,
 * 한쪽만 새 이름으로 바뀌면 버튼을 눌러도 아무 일도 일어나지 않는 구간이 생긴다.
 */
test("케이스 칸은 옛 키 이름을 그대로 쓴다", async () => {
  const db = await freshDb();
  const request = await requestCollect(db, "cases");
  assert.equal(await getAppState(db, "collect_requested_seq"), String(request.seq));
  assert.notEqual(await getAppState(db, "collect_requested_at"), null);

  await markCollectHandled(db, "cases", request.seq);
  assert.equal(await getAppState(db, "collect_handled_seq"), String(request.seq));
  await db.close();
});

test("옛 배포가 남긴 케이스 번호를 이어서 센다", async () => {
  const db = await freshDb();
  // 지금 돌고 있는 앱이 남긴 상태.
  await db.run(
    "INSERT INTO app_state (key, value, updated_at) VALUES ('collect_requested_seq','41',''), ('collect_handled_seq','41','')",
  );
  assert.equal(await pendingCollectRequest(db, "cases"), null, "옛 요청이 되살아나면 또 돈다");

  const request = await requestCollect(db, "cases");
  assert.equal(request.seq, 42, "1 로 되돌아가면 집어간 번호보다 작아 영원히 안 집힌다");
  assert.equal(await pendingCollectRequest(db, "cases"), 42);
  await db.close();
});

/*
 * 종류를 말하지 않은 요청(이미 배포된 화면이 그렇게 부른다).
 *
 * app/api/collect/route.ts 는 "next/server" 를 임포트해 node --test 에서 직접 불러올 수
 * 없다(test/settingsAudit.test.ts 머리말과 같은 이유 — 실측 확인). 그래서 라우트가 하는
 * 순서(parseCollectKind → requestCollect)를 그대로 재현해 잰다.
 */
test("종류 없이 부르면 케이스 수집 요청이 된다", async () => {
  const db = await freshDb();
  const kind = parseCollectKind(null);           // 라우트가 ?kind 없는 요청에서 얻는 값
  assert.ok(kind !== null);

  const request = await requestCollect(db, kind);
  assert.equal(await pendingCollectRequest(db, "cases"), request.seq);
  assert.equal(await pendingCollectRequest(db, "cves"), null);
  assert.equal(await pendingCollectRequest(db, "kb"), null);
  await db.close();
});

/*
 * 끝났다는 표시.
 *
 * 보안 공지·기술 문서 수집기는 runs 에 아무것도 남기지 않으므로, 화면은 이 표시만 보고
 * "완료" 로 바꾼다. 없거나 뒤집히면 버튼이 영원히 "수집 중" 이거나, 실패한 회차를
 * 완료라고 말한다.
 */

test("끝나기 전에는 완료 번호가 내 번호에 못 미친다", async () => {
  const db = await freshDb();
  const request = await requestCollect(db, "cves");
  await markCollectHandled(db, "cves", request.seq);

  assert.equal((await collectOutcome(db, "cves")).seq, 0, "집어간 것만으로 완료가 되면 안 된다");
  await markCollectFinished(db, "cves", request.seq, true);
  assert.deepEqual(await collectOutcome(db, "cves"), { seq: 1, ok: true });
  await db.close();
});

test("실패로 끝난 회차는 실패로 남는다", async () => {
  const db = await freshDb();
  const request = await requestCollect(db, "kb");
  await markCollectFinished(db, "kb", request.seq, false);
  assert.deepEqual(await collectOutcome(db, "kb"), { seq: 1, ok: false });
  await db.close();
});

test("완료 표시도 종류끼리 섞이지 않는다", async () => {
  const db = await freshDb();
  await markCollectFinished(db, "cves", 7, true);
  assert.equal((await collectOutcome(db, "kb")).seq, 0);
  assert.equal((await collectOutcome(db, "cases")).seq, 0);
  await db.close();
});

test("완료 번호는 되돌아가지 않는다", async () => {
  const db = await freshDb();
  await markCollectFinished(db, "kb", 5, true);
  await markCollectFinished(db, "kb", 3, false);   // 뒤늦게 도착한 옛 표시
  assert.deepEqual(await collectOutcome(db, "kb"), { seq: 5, ok: true }, "되돌리면 끝난 요청이 되살아난다");
  await db.close();
});

test("완료 기록이 없으면 실패로 보지 않는다", async () => {
  const db = await freshDb();
  // 이 표시를 쓰기 전 배포가 남긴 상태. 실패로 단정하면 멀쩡한 회차를 실패로 보여준다.
  assert.equal((await collectOutcome(db, "cves")).ok, true);
  await db.close();
});
