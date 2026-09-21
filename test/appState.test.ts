/**
 * app_state — 프로세스 사이에 남기는 작은 값들.
 *
 * 지금 쓰는 곳은 자동 요약의 워터마크다. 이 값이 잘못 움직이면 쌓여 있던 287건이
 * 한꺼번에 요약 대상이 되어 다섯 시간치 LLM 호출이 시작된다. 그래서 "한 번 박히면
 * 안 바뀐다" 를 시험으로 고정한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../lib/db.ts";
import { getAppState, initAppState, setAppState } from "../lib/appState.ts";

async function withDb(run: (db: Awaited<ReturnType<typeof openDb>>) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "srstate-"));
  const db = await openDb(join(dir, "test.db"));
  try {
    await run(db);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// 빈 문자열과 "설정 안 됨" 은 다르다. null 로 구분한다.
test("없는 키는 null 이다", async () => {
  await withDb(async (db) => {
    assert.equal(await getAppState(db, "없는키"), null);
  });
});

test("넣은 값을 그대로 읽는다", async () => {
  await withDb(async (db) => {
    await setAppState(db, "k", "v1");
    assert.equal(await getAppState(db, "k"), "v1");
  });
});

test("같은 키에 다시 넣으면 덮어쓴다", async () => {
  await withDb(async (db) => {
    await setAppState(db, "k", "v1");
    await setAppState(db, "k", "v2");
    assert.equal(await getAppState(db, "k"), "v2");
  });
});

// 워터마크의 핵심 성질 — 처음 한 번만 정해지고 그 뒤로는 안 바뀐다.
test("initAppState 는 처음 값만 남기고 이후 호출은 기존 값을 돌려준다", async () => {
  await withDb(async (db) => {
    assert.equal(await initAppState(db, "watermark", "100"), "100");
    assert.equal(await initAppState(db, "watermark", "999"), "100");
    assert.equal(await getAppState(db, "watermark"), "100");
  });
});

// 빈 문자열도 "설정됨" 이다. 이걸 null 로 보면 매 회차 워터마크가 다시 박힌다.
test("빈 문자열도 설정된 값으로 본다", async () => {
  await withDb(async (db) => {
    await setAppState(db, "k", "");
    assert.equal(await getAppState(db, "k"), "");
    assert.equal(await initAppState(db, "k", "나중값"), "");
  });
});
