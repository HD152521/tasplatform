import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  finishRun, getExistingCaseIndex, getKnownThreadIds,
  listRuns, openDb, startRun, upsertCase, upsertThread,
} from "../lib/db.ts";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "srhub-"));
  const db = openDb(join(dir, "test.db"));
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const sampleCase = (lastUpdated: string) => ({
  request_id: 37074096, request_id_formatted: "37074096", subject: "테스트 케이스",
  status: "Open", priority: "P3", category: "Ops", party_name: "고객사",
  party_site_number: "1", created_on: "01-September-2026 23:39:29",
  created_on_ms: 1, last_updated: lastUpdated, last_updated_ms: 2,
  last_fetched_at: "2026-09-02T00:00:00Z", raw_json: "{}",
  description_html: "", description_text: "", case_version: null,
  product_id: null, product_name: "", component_id: null, component_name: "",
});

test("스키마가 적용되고 케이스를 저장한다", () => {
  const { db, cleanup } = tempDb();
  try {
    upsertCase(db, sampleCase("a"));
    const index = getExistingCaseIndex(db);
    assert.equal(index.get(37074096), "a");
  } finally { cleanup(); }
});

test("같은 케이스를 두 번 넣어도 행이 늘지 않는다 (멱등)", () => {
  const { db, cleanup } = tempDb();
  try {
    upsertCase(db, sampleCase("a"));
    upsertCase(db, sampleCase("b"));
    assert.equal(getExistingCaseIndex(db).size, 1);
    assert.equal(getExistingCaseIndex(db).get(37074096), "b");
  } finally { cleanup(); }
});

test("스레드를 저장하고 아는 id 집합을 돌려준다", () => {
  const { db, cleanup } = tempDb();
  try {
    upsertThread(db, {
      thread_id: 157212720, request_id: 37074096, author_unit: "Broadcom Internal",
      author_unit_id: 1498068, is_ours: 0, res_date_ms: 1788332081701,
      res_date_val: "01-September-2026 23:54:41", body_html: "<p>hi</p>",
      body_text: "hi", fetched_at: "2026-09-02T00:00:00Z",
    });
    assert.ok(getKnownThreadIds(db, 37074096).has(157212720));
    assert.equal(getKnownThreadIds(db, 999).size, 0);
  } finally { cleanup(); }
});

test("run 은 세 가지 상태를 구분해 기록한다", () => {
  const { db, cleanup } = tempDb();
  try {
    const okId = startRun(db);
    finishRun(db, okId, { status: "success", casesSeen: 6, casesChanged: 1, newThreads: 2, sessionState: "valid" });

    const expiredId = startRun(db);
    finishRun(db, expiredId, { status: "session_expired", sessionState: "expired", error: "세션 만료" });

    const runs = listRuns(db);
    assert.equal(runs.length, 2);
    assert.equal(runs[0]?.status, "session_expired");
    assert.equal(runs[1]?.status, "success");
    // 만료 회차는 '새 답변 0건'이 아니라 조회 자체를 못 한 것
    assert.equal(runs[0]?.new_threads, 0);
    assert.equal(runs[0]?.session_state, "expired");
    assert.equal(runs[1]?.new_threads, 2);
  } finally { cleanup(); }
});

test("본문을 한 번 저장하면 빈 값 업데이트로 지워지지 않는다", () => {
  const { db, cleanup } = tempDb();
  try {
    upsertCase(db, { ...sampleCase("a"), description_html: "<p>원문</p>", description_text: "원문" });
    // 다음 회차에 본문 조회가 실패해 빈 값으로 들어와도 기존 본문은 남아야 한다
    upsertCase(db, sampleCase("b"));
    const row = db
      .prepare("SELECT description_text FROM cases WHERE request_id = ?")
      .all(37074096) as Array<{ description_text: string }>;
    assert.equal(row[0]?.description_text, "원문");
  } finally { cleanup(); }
});
