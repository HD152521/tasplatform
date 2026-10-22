/**
 * 자동 게시 대상 고르기.
 *
 * 이 판정이 느슨하면 **과거 SR 수십 건이 한꺼번에 Confluence 로 쏟아진다.** 그 전에
 * AI 를 수십 번 때리고, 되돌리려면 손으로 지워야 한다. 그래서 울타리 하나하나를 잠근다.
 *
 * 실제 케이스 번호는 쓰지 않는다 — 이 저장소는 공개다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../lib/db.ts";
import { isoNow } from "../lib/dates.ts";
import { markSrJiraCommented, saveSrJiraLink } from "../lib/jiraLinkStore.ts";
import {
  LOCK_KEY, SINCE_KEY, bumpCommentTries, bumpPublishTries, claimRun, countCommentGivenUp,
  countGivenUp, findCommentable, findPublishable, readSince, refundPublishTries, releaseRun,
} from "../lib/autopublish.ts";
import { getAppState, setAppState } from "../lib/appState.ts";

const SINCE = 1_700_000_000_000;
const AFTER = SINCE + 60_000;    // 기준 시각 이후에 생성
const BEFORE = SINCE - 60_000;   // 그 전에 생성(= 과거 SR)

async function freshDb(): Promise<Db> {
  return openDb(join(mkdtempSync(join(tmpdir(), "autopub-")), "sr.db"));
}

/** 케이스 한 건을 심는다. */
async function putCase(db: Db, o: {
  id: number; status: string; createdMs: number; ticket?: boolean; published?: boolean;
}): Promise<void> {
  await db.run(
    `INSERT INTO cases
       (request_id, request_id_formatted, subject, status, created_on_ms, last_updated_ms,
        first_seen_at, last_fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [o.id, String(o.id), "제목", o.status, o.createdMs, o.createdMs + 1000, isoNow(), isoNow()],
  );
  if (o.ticket !== false) {
    await saveSrJiraLink(db, { requestId: o.id, issueKey: `PRJ-${o.id}` });
  }
  if (o.published === true) {
    await db.run(
      `INSERT INTO case_summaries (request_id, kind, content, source, generated_at)
       VALUES (?, 'confluence_published', 'https://conf.test/x', 'ai', ?)`,
      [o.id, isoNow()],
    );
  }
}

test("종료되고 기준 이후에 생성되고 티켓이 있으면 대상이다", async () => {
  const db = await freshDb();
  await putCase(db, { id: 1001, status: "Closed", createdMs: AFTER });
  const found = await findPublishable(db, SINCE);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.requestId, 1001);
  assert.equal(found[0]?.issueKey, "PRJ-1001", "Postgres 소문자 접힘에 걸리는 자리다");
  assert.equal(found[0]?.caseLabel, "1001");
  await db.close();
});

/*
 * **가장 중요한 울타리.** 기능이 들어가기 전에 생성된 SR 은 종료돼도 대상이 아니다.
 * 종료일이 아니라 **생성일**로 본다 — "지금부터 올라온 것" 이 그 뜻이다.
 */
test("기준 시각 전에 생성된 SR 은 종료돼도 대상이 아니다", async () => {
  const db = await freshDb();
  await putCase(db, { id: 1002, status: "Closed", createdMs: BEFORE });
  assert.deepEqual(await findPublishable(db, SINCE), []);
  await db.close();
});

/*
 * 두 번째 울타리. 티켓 행은 **새 생성 버튼을 거친 SR 에만** 생기므로, 포털에서 직접
 * 올린 SR 과 옛 SR 이 구조적으로 빠진다.
 */
test("티켓이 없는 SR 은 대상이 아니다", async () => {
  const db = await freshDb();
  await putCase(db, { id: 1003, status: "Closed", createdMs: AFTER, ticket: false });
  assert.deepEqual(await findPublishable(db, SINCE), []);
  await db.close();
});

test("아직 열려 있으면 대상이 아니다", async () => {
  const db = await freshDb();
  for (const [i, status] of ["Open", "In Progress", "Waiting on Customer"].entries()) {
    await putCase(db, { id: 1100 + i, status, createdMs: AFTER });
  }
  assert.deepEqual(await findPublishable(db, SINCE), []);
  await db.close();
});

/*
 * 취소된 SR 은 정리할 내용이 없다 — 올릴 문서가 아니다. `isClosedStatus` 는 cancel 도
 * 종료로 보지만 여기서는 쓰지 않는다(collector/prewarm.ts 와 같은 선택).
 */
test("취소된 SR 은 대상이 아니다", async () => {
  const db = await freshDb();
  await putCase(db, { id: 1004, status: "Cancelled", createdMs: AFTER });
  assert.deepEqual(await findPublishable(db, SINCE), []);
  await db.close();
});

test("이미 올린 SR 은 대상이 아니다", async () => {
  const db = await freshDb();
  await putCase(db, { id: 1005, status: "Resolved", createdMs: AFTER, published: true });
  assert.deepEqual(await findPublishable(db, SINCE), []);
  await db.close();
});

/*
 * 영구히 실패하는 건(요약이 안 되는 깨진 케이스 등)이 매번 AI 를 때리지 않게 한다.
 * 조건으로 대상을 고르는 구조라 상한이 없으면 무한히 되풀이한다.
 */
test("시도 횟수가 상한에 닿으면 더 집지 않는다", async () => {
  const db = await freshDb();
  await putCase(db, { id: 1006, status: "Closed", createdMs: AFTER });
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await findPublishable(db, SINCE, 10, 3)).length, 1, `${i}번째`);
    await bumpPublishTries(db, 1006);
  }
  assert.deepEqual(await findPublishable(db, SINCE, 10, 3), [], "상한을 넘겼는데 또 집었다");
  await db.close();
});

test("한 회차 상한을 지키고 오래된 것부터 집는다", async () => {
  const db = await freshDb();
  await putCase(db, { id: 1007, status: "Closed", createdMs: AFTER + 3000 });
  await putCase(db, { id: 1008, status: "Closed", createdMs: AFTER + 1000 });
  await putCase(db, { id: 1009, status: "Closed", createdMs: AFTER + 2000 });
  const found = await findPublishable(db, SINCE, 2);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((f) => f.requestId), [1008, 1009], "오래된 것부터가 아니다");
  await db.close();
});

/* ------------------------------------------------------------------ *
 * 기준 시각
 * ------------------------------------------------------------------ */

/*
 * **처음 돌 때는 아무것도 하지 않아야 한다.** 그 순간 이미 종료돼 있던 SR 들이 전부
 * 대상이 되면 안 된다. prewarm 이 같은 규칙으로 287건을 막았다.
 */
test("처음 읽으면 지금으로 박고 first 를 알린다", async () => {
  const db = await freshDb();
  const got = await readSince(db);
  assert.equal(got.first, true);
  assert.ok(got.sinceMs > 0);
  const again = await readSince(db);
  assert.equal(again.first, false, "두 번째는 처음이 아니다");
  assert.equal(again.sinceMs, got.sinceMs, "기준이 밀렸다 — 과거가 열린다");
  await db.close();
});

/*
 * **같은 밀리초에 두 번 읽어도 두 번째는 처음이 아니다.**
 *
 * 한때 `first` 를 `stored === String(Date.now())` 로 판정했다. 두 호출이 같은 밀리초에
 * 떨어지면 그 비교가 참이 되어 두 번째도 "첫 실행" 이 된다 — 그러면 그 회차는 아무것도
 * 올리지 않고 넘어간다. 느린 PC 에서는 안 걸리고 빠른 CI 러너(911건 11초)에서만 깨졌다.
 * 시계를 멈춰 결정적으로 확인한다.
 */
test("같은 밀리초에 두 번 읽어도 두 번째는 처음이 아니다", async () => {
  const db = await freshDb();
  const realNow = Date.now;
  const frozen = realNow.call(Date);
  Date.now = () => frozen;
  try {
    assert.equal((await readSince(db)).first, true);
    const again = await readSince(db);
    assert.equal(again.first, false, "같은 밀리초인데 두 번째도 처음이 됐다");
    assert.equal(again.sinceMs, frozen, "기준이 밀렸다 — 과거가 열린다");
  } finally {
    Date.now = realNow;
    await db.close();
  }
});

// 값이 깨져 있으면 과거를 열어 주는 쪽으로 기울지 않는다.
test("기준 값이 깨져 있으면 지금으로 다시 박는다", async () => {
  const db = await freshDb();
  await setAppState(db, SINCE_KEY, "이상한값");
  const got = await readSince(db);
  assert.equal(got.first, true);
  assert.ok(Number.isFinite(got.sinceMs) && got.sinceMs > 0);
  await db.close();
});

/* ------------------------------------------------------------------ *
 * 자물쇠
 * ------------------------------------------------------------------ */

test("한 번만 맡고, 놓으면 다시 맡을 수 있다", async () => {
  const db = await freshDb();
  assert.equal(await claimRun(db), true);
  assert.equal(await claimRun(db), false, "두 번 맡았다");
  await releaseRun(db);
  assert.equal(await claimRun(db), true);
  await db.close();
});

/*
 * 돌던 요청이 죽으면(컨테이너 재시작 등) 자물쇠가 남는다. 상하지 않으면 아무도 못 돌게
 * 되어 자동 게시가 조용히 멈춘다 — 자동 기능의 가장 흔한 고장이다.
 */
test("오래 남은 자물쇠는 버려진 것으로 본다", async () => {
  const db = await freshDb();
  await setAppState(db, LOCK_KEY, String(Date.now() - 60 * 60 * 1000));
  assert.equal(await claimRun(db, 15 * 60 * 1000), true);
  await db.close();
});

test("놓으면 자물쇠 자리가 비워진다", async () => {
  const db = await freshDb();
  await claimRun(db);
  await releaseRun(db);
  assert.equal(await getAppState(db, LOCK_KEY), "");
  await db.close();
});

/*
 * 세어 보기(dry run)는 **아무것도 바꾸지 않아야 한다.**
 *
 * 박는 시각이 곧 "이때부터 대상" 이다. 기능을 켜기 몇 주 전에 세어 보다가 박히면 그
 * 사이에 생성된 SR 이 전부 대상에 들어온다 — 일찍 박는 쪽이 안전해 보이지만 반대로
 * **그물을 넓히는 방향**이다.
 */
test("세어 보기는 기준 시각을 박지 않는다", async () => {
  const db = await freshDb();
  const peek = await readSince(db, { stamp: false });
  assert.equal(peek.initialized, false, "아직 기준이 없다고 말해야 한다");
  assert.equal(await getAppState(db, SINCE_KEY), null, "세어 보기가 값을 박았다");

  // 박은 뒤에는 그 값을 읽어 온다.
  const stamped = await readSince(db);
  const again = await readSince(db, { stamp: false });
  assert.equal(again.initialized, true);
  assert.equal(again.sinceMs, stamped.sinceMs);
  await db.close();
});

/*
 * ## 기준 값이 0·빈 문자열이면 **과거가 열린다**
 *
 * `Number("")` 와 `Number(" ")` 는 0 이고 `isFinite(0)` 은 참이다. 그래서 "값이 깨졌다"
 * 검사를 `isFinite` 만으로 하면 통과하고, `created_on_ms > 0` 은 **모든 SR 에 참**이
 * 된다 — 과거 SR 이 전부 대상이 되어 화면을 열 때마다 상한만큼 쏟아진다.
 */
test("기준 값이 0·빈값·음수면 쓰지 않고 지금으로 다시 박는다", async () => {
  for (const bad of ["", "   ", "0", "-1", "이상한값", "NaN"]) {
    const db = await freshDb();
    await setAppState(db, SINCE_KEY, bad);

    const stamped = await readSince(db);
    assert.equal(stamped.first, true, `${JSON.stringify(bad)} 를 멀쩡한 값으로 봤다`);
    assert.ok(stamped.sinceMs > 0);

    // 세어 보기도 같은 판정이어야 한다.
    const db2 = await freshDb();
    await setAppState(db2, SINCE_KEY, bad);
    const peek = await readSince(db2, { stamp: false });
    assert.equal(peek.initialized, false, `세어 보기가 ${JSON.stringify(bad)} 를 받아들였다`);

    await db.close();
    await db2.close();
  }
});

/*
 * 환경 문제(토큰 만료·설정 누락·Confluence 장애)에 시도 횟수를 먹이면, 고친 뒤에도
 * 상한에 닿아 **영영 집히지 않는다.** 그래서 되돌릴 수 있어야 한다.
 */
test("시도 횟수를 되돌릴 수 있고 0 밑으로 가지 않는다", async () => {
  const db = await freshDb();
  await putCase(db, { id: 1010, status: "Closed", createdMs: AFTER });
  await bumpPublishTries(db, 1010);
  await bumpPublishTries(db, 1010);
  await refundPublishTries(db, 1010);
  assert.equal((await findPublishable(db, SINCE))[0]?.tries, 1);

  await refundPublishTries(db, 1010);
  await refundPublishTries(db, 1010);
  assert.equal((await findPublishable(db, SINCE))[0]?.tries, 0, "0 밑으로 내려갔다");
  await db.close();
});

/*
 * 포기한 건은 대상 조회에서 빠지므로 **어디에도 보이지 않는다.** 그러면 자동 게시가
 * 조용히 멈춘 것을 아무도 모른다 — 세어서 보여 준다.
 */
test("상한에 닿아 포기한 건수를 센다", async () => {
  const db = await freshDb();
  await putCase(db, { id: 1011, status: "Closed", createdMs: AFTER });
  await putCase(db, { id: 1012, status: "Closed", createdMs: AFTER });
  assert.equal(await countGivenUp(db, SINCE), 0);

  for (let i = 0; i < 3; i += 1) await bumpPublishTries(db, 1011);
  assert.equal(await countGivenUp(db, SINCE), 1);
  assert.equal((await findPublishable(db, SINCE)).length, 1, "포기한 건이 대상에 남았다");

  // 올린 건은 포기 대상도 아니다.
  await putCase(db, { id: 1013, status: "Closed", createdMs: AFTER, published: true });
  for (let i = 0; i < 3; i += 1) await bumpPublishTries(db, 1013);
  assert.equal(await countGivenUp(db, SINCE), 1, "이미 올린 건을 포기로 셌다");
  await db.close();
});

/* ------------------------------------------------------------------ *
 * 게시는 됐는데 **댓글만** 못 단 건
 *
 * 게시가 성공하면 `confluence_published` 행이 생기고, 그 뒤로 그 SR 은 게시 대상 조회에서
 * 빠진다. 그래서 그때 댓글이 실패하면 **영구히 누락됐다** — 다시 집는 조회가 없었다.
 * 알림도 그 순간 화면을 연 사람에게만 보이고 새로고침하면 사라졌다.
 * ------------------------------------------------------------------ */

/** 게시까지 끝난 상태로 심는다. */
async function putPublished(db: Db, o: {
  id: number; url?: string; summary?: string; commented?: boolean;
}): Promise<void> {
  await putCase(db, { id: o.id, status: "Closed", createdMs: AFTER, published: true });
  await db.run(
    "UPDATE case_summaries SET content = ? WHERE request_id = ? AND kind = 'confluence_published'",
    [o.url ?? "https://conf.test/wiki/x", o.id],
  );
  if (o.summary !== undefined) {
    await db.run(
      `INSERT INTO case_summaries (request_id, kind, content, source, generated_at)
       VALUES (?, 'confluence', ?, 'ai', ?)`,
      [o.id, o.summary, isoNow()],
    );
  }
  if (o.commented === true) await markSrJiraCommented(db, o.id);
}

test("게시됐고 댓글만 안 달린 건을 집는다", async () => {
  const db = await freshDb();
  await putPublished(db, { id: 2001, summary: "### 조치\n해소했습니다." });

  // 게시 대상에서는 빠져 있어야 한다(이미 올렸으므로).
  assert.deepEqual(await findPublishable(db, SINCE), []);

  const behind = await findCommentable(db, SINCE);
  assert.equal(behind.length, 1, "영구 누락되던 자리다");
  assert.equal(behind[0]?.issueKey, "PRJ-2001");
  assert.equal(behind[0]?.pageUrl, "https://conf.test/wiki/x", "댓글에 넣을 링크");
  assert.match(behind[0]?.summary ?? "", /해소했습니다/, "결과를 뽑을 본문");
  await db.close();
});

test("이미 댓글을 단 건은 집지 않는다", async () => {
  const db = await freshDb();
  await putPublished(db, { id: 2002, commented: true });
  assert.deepEqual(await findCommentable(db, SINCE), []);
  await db.close();
});

test("아직 게시되지 않은 건은 댓글 대상이 아니다", async () => {
  const db = await freshDb();
  await putCase(db, { id: 2003, status: "Closed", createdMs: AFTER });
  assert.deepEqual(await findCommentable(db, SINCE), []);
  await db.close();
});

// 과거 SR 은 여기서도 빠져야 한다. 울타리가 한 곳만 있으면 새는 길이 생긴다.
test("기준 시각 전에 생성된 건은 댓글 대상도 아니다", async () => {
  const db = await freshDb();
  await putCase(db, { id: 2004, status: "Closed", createdMs: BEFORE, published: true });
  assert.deepEqual(await findCommentable(db, SINCE), []);
  await db.close();
});

test("댓글 시도 횟수가 상한에 닿으면 포기하고, 그 건수를 센다", async () => {
  const db = await freshDb();
  await putPublished(db, { id: 2005 });
  assert.equal(await countCommentGivenUp(db, SINCE), 0);
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await findCommentable(db, SINCE, 10, 3)).length, 1, `${i}번째`);
    await bumpCommentTries(db, 2005);
  }
  assert.deepEqual(await findCommentable(db, SINCE, 10, 3), []);
  assert.equal(await countCommentGivenUp(db, SINCE, 3), 1);
  await db.close();
});

// 요약이 없어도 댓글은 단다 — 결과 줄이 빠지고 링크만 남는다. 없는 것보다 낫다.
test("요약이 없어도 대상이고 summary 는 빈 문자열이다", async () => {
  const db = await freshDb();
  await putPublished(db, { id: 2006 });
  const behind = await findCommentable(db, SINCE);
  assert.equal(behind.length, 1);
  assert.equal(behind[0]?.summary, "");
  await db.close();
});
