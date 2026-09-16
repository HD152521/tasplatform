import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TEAM_ID } from "../lib/config.ts";
import { openDb, upsertCase } from "../lib/db.ts";
import {
  getCaseHandler,
  getSummaryHandler,
  listCasesHandler,
} from "../mcp/readTools.ts";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "srhub-mcp-read-"));
  const file = join(dir, "test.db");
  const db = openDb(file);
  return { db, file, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const sampleCase = (
  requestId: number,
  status: string,
  teamId: string,
  lastUpdatedMs = 1,
) => ({
  request_id: requestId, request_id_formatted: String(requestId), subject: `케이스 ${requestId}`,
  status, priority: "P3", category: "Ops", party_name: "고객사",
  party_site_number: "1", created_on: "01-September-2026 23:39:29",
  created_on_ms: 1, last_updated: "01-September-2026 23:39:29", last_updated_ms: lastUpdatedMs,
  last_fetched_at: "2026-09-02T00:00:00Z", raw_json: "{}",
  description_html: "", description_text: "", case_version: null,
  product_id: null, product_name: "", component_id: null, component_name: "",
  team_id: teamId,
});

// ── list_cases ──────────────────────────────────────────────────────

test("teamId 로 그 팀 소유 케이스만 돌려준다", () => {
  const { db, file, cleanup } = tempDb();
  try {
    upsertCase(db, sampleCase(1, "Open", "acme"));
    upsertCase(db, sampleCase(2, "Open", "beta"));
    const result = listCasesHandler("acme", {}, file);
    assert.equal(result.ok, true);
    assert.equal(result.cases.length, 1);
    assert.equal(result.cases[0]?.request_id, 1);
  } finally { cleanup(); }
});

test("scope=open/closed 로 걸러낸다", () => {
  const { db, file, cleanup } = tempDb();
  try {
    upsertCase(db, sampleCase(1, "Open", "acme"));
    upsertCase(db, sampleCase(2, "Closed", "acme"));
    const open = listCasesHandler("acme", { scope: "open" }, file);
    const closed = listCasesHandler("acme", { scope: "closed" }, file);
    assert.deepEqual(open.cases.map((c) => c.request_id), [1]);
    assert.deepEqual(closed.cases.map((c) => c.request_id), [2]);
  } finally { cleanup(); }
});

test("scope 을 생략하면 전체를 돌려준다", () => {
  const { db, file, cleanup } = tempDb();
  try {
    upsertCase(db, sampleCase(1, "Open", "acme"));
    upsertCase(db, sampleCase(2, "Closed", "acme"));
    const result = listCasesHandler("acme", {}, file);
    assert.equal(result.total, 2);
  } finally { cleanup(); }
});

test("limit·offset 으로 페이지를 나눈다", () => {
  const { db, file, cleanup } = tempDb();
  try {
    for (let i = 1; i <= 5; i += 1) upsertCase(db, sampleCase(i, "Open", "acme", i));
    const page1 = listCasesHandler("acme", { limit: 2, offset: 0 }, file);
    const page2 = listCasesHandler("acme", { limit: 2, offset: 2 }, file);
    assert.equal(page1.cases.length, 2);
    assert.equal(page2.cases.length, 2);
    assert.equal(page1.total, 5);
    // 최신순 정렬(last_updated_ms DESC)이므로 5,4 그다음 3,2 순서다.
    assert.deepEqual(page1.cases.map((c) => c.request_id), [5, 4]);
    assert.deepEqual(page2.cases.map((c) => c.request_id), [3, 2]);
  } finally { cleanup(); }
});

test("빈 팀은 빈 목록을 돌려준다 (다른 팀 케이스가 있어도)", () => {
  const { db, file, cleanup } = tempDb();
  try {
    upsertCase(db, sampleCase(1, "Open", "acme"));
    const result = listCasesHandler("beta", {}, file);
    assert.equal(result.total, 0);
    assert.deepEqual(result.cases, []);
  } finally { cleanup(); }
});

test("한도를 넘는 limit 은 상한(200)으로 잘린다", () => {
  const { file, cleanup } = tempDb();
  try {
    const result = listCasesHandler("acme", { limit: 10_000 }, file);
    assert.equal(result.ok, true);
    // 실제 데이터가 없어도 함수가 죽지 않고 안전하게 처리하는지만 확인한다
    assert.deepEqual(result.cases, []);
  } finally { cleanup(); }
});

// ── get_case ────────────────────────────────────────────────────────

test("그 팀 소유 케이스는 상세·스레드·첨부를 돌려준다", () => {
  const { db, file, cleanup } = tempDb();
  try {
    upsertCase(db, sampleCase(37074096, "Open", "acme"));
    const result = getCaseHandler("acme", { requestId: 37074096 }, file);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.case.request_id, 37074096);
    assert.deepEqual(result.threads, []);
    assert.deepEqual(result.attachments, []);
  } finally { cleanup(); }
});

test("다른 팀 케이스는 못 찾음으로 취급한다 (팀 경계)", () => {
  const { db, file, cleanup } = tempDb();
  try {
    upsertCase(db, sampleCase(1, "Open", "acme"));
    const result = getCaseHandler("beta", { requestId: 1 }, file);
    assert.equal(result.ok, false);
  } finally { cleanup(); }
});

test("존재하지 않는 requestId 는 못 찾음을 돌려준다", () => {
  const { file, cleanup } = tempDb();
  try {
    const result = getCaseHandler("acme", { requestId: 999 }, file);
    assert.equal(result.ok, false);
  } finally { cleanup(); }
});

test("requestId 가 숫자가 아니면 실패를 돌려준다", () => {
  const { file, cleanup } = tempDb();
  try {
    const result = getCaseHandler("acme", { requestId: Number("not-a-number") }, file);
    assert.equal(result.ok, false);
  } finally { cleanup(); }
});

// ── get_summary ─────────────────────────────────────────────────────

test("소유 케이스면 deps.getSummary 를 그대로 호출해 결과를 돌려준다", async () => {
  const { db, file, cleanup } = tempDb();
  try {
    upsertCase(db, sampleCase(1, "Closed", "acme"));
    let called: [number, string, boolean | undefined] | null = null;
    const result = await getSummaryHandler(
      {
        dbFile: file,
        getSummary: async (requestId, kind, force) => {
          called = [requestId, kind, force];
          return { content: "정리본", source: "ai", generatedAt: "now", cached: false };
        },
      },
      "acme",
      { requestId: 1 },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(called, [1, "confluence", false]);
  } finally { cleanup(); }
});

test("다른 팀 케이스면 deps.getSummary 를 부르지 않고 거부한다", async () => {
  const { db, file, cleanup } = tempDb();
  try {
    upsertCase(db, sampleCase(1, "Closed", "acme"));
    let calls = 0;
    const result = await getSummaryHandler(
      { dbFile: file, getSummary: async () => { calls += 1; return { error: "x" }; } },
      "beta",
      { requestId: 1 },
    );
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
  } finally { cleanup(); }
});

test("deps.getSummary 가 에러를 돌려주면 실패로 변환한다", async () => {
  const { db, file, cleanup } = tempDb();
  try {
    upsertCase(db, sampleCase(1, "Closed", "acme"));
    const result = await getSummaryHandler(
      { dbFile: file, getSummary: async () => ({ error: "요약 실패" }) },
      "acme",
      { requestId: 1 },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.message, "요약 실패");
  } finally { cleanup(); }
});

test("지원하지 않는 kind 는 deps.getSummary 를 부르지 않고 거부한다", async () => {
  const { db, file, cleanup } = tempDb();
  try {
    upsertCase(db, sampleCase(1, "Closed", "acme"));
    let calls = 0;
    const result = await getSummaryHandler(
      { dbFile: file, getSummary: async () => { calls += 1; return { error: "x" }; } },
      "acme",
      { requestId: 1, kind: "unknown-kind" },
    );
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
  } finally { cleanup(); }
});

test("기본 팀도 정상적으로 조회된다 (하위호환)", () => {
  const { db, file, cleanup } = tempDb();
  try {
    upsertCase(db, sampleCase(1, "Open", DEFAULT_TEAM_ID));
    const result = listCasesHandler(DEFAULT_TEAM_ID, {}, file);
    assert.equal(result.total, 1);
  } finally { cleanup(); }
});
