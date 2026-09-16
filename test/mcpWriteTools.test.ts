import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAudit, openDb, upsertCase } from "../lib/db.ts";
import type { WriteDeps } from "../mcp/writeTools.ts";
import { createSrHandler, replyHandler } from "../mcp/writeTools.ts";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "srhub-mcp-write-"));
  const file = join(dir, "test.db");
  const db = openDb(file);
  return { db, file, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const sampleCase = (requestId: number, status: string, teamId: string) => ({
  request_id: requestId, request_id_formatted: String(requestId), subject: "테스트 케이스",
  status, priority: "P3", category: "Ops", party_name: "고객사",
  party_site_number: "1", created_on: "01-September-2026 23:39:29",
  created_on_ms: 1, last_updated: "01-September-2026 23:39:29", last_updated_ms: 1,
  last_fetched_at: "2026-09-02T00:00:00Z", raw_json: "{}",
  description_html: "", description_text: "", case_version: null,
  product_id: null, product_name: "", component_id: null, component_name: "",
  team_id: teamId,
});

interface DepsTracker {
  deps: WriteDeps;
  refreshOpenCasesCalls: Array<{ teamId?: string }>;
  refreshCaseThreadsCalls: Array<{ requestId: number }>;
  hasSession: boolean;
}

function fakeDeps(overrides: Partial<WriteDeps> & { hasSession?: boolean; dbFile?: string } = {}): DepsTracker {
  let persistCalled = 0;
  const refreshOpenCasesCalls: Array<{ teamId?: string }> = [];
  const refreshCaseThreadsCalls: Array<{ requestId: number }> = [];
  const hasSession = overrides.hasSession ?? true;

  const client = {
    get: async () => { throw new Error("get() 은 이 테스트에서 쓰지 않는다"); },
    post: async () => { throw new Error("post() 는 이 테스트에서 쓰지 않는다"); },
    persist: () => { persistCalled += 1; return true; },
  };

  const deps: WriteDeps = {
    hasTeamSession: overrides.hasTeamSession ?? (() => hasSession),
    fetchClient: overrides.fetchClient ?? (() => client),
    sessionFileForTeam: overrides.sessionFileForTeam ?? ((teamId: string) => `data/teams/${teamId}/session.json`),
    postReply: overrides.postReply ?? (async () => ({ ok: true, message: "등록됨" })),
    createCase: overrides.createCase
      ?? (async () => ({ ok: true, requestId: 555, requestIdFormatted: "555", message: "등록됨" })),
    refreshCaseThreads: overrides.refreshCaseThreads
      ?? (async (_client, requestId: number) => { refreshCaseThreadsCalls.push({ requestId }); return true; }),
    refreshOpenCases: overrides.refreshOpenCases
      ?? (async (_client, teamId?: string) => { refreshOpenCasesCalls.push({ teamId }); return true; }),
    dbFile: overrides.dbFile,
  };

  return { deps, refreshOpenCasesCalls, refreshCaseThreadsCalls, hasSession };
}

// ── create_sr ───────────────────────────────────────────────────────

test("제목·내용이 비면 세션 확인 없이 즉시 거부한다", async () => {
  let sessionChecked = false;
  const tracker = fakeDeps({ hasTeamSession: () => { sessionChecked = true; return true; } });
  const result = await createSrHandler(tracker.deps, "acme", { subject: "", content: "", priorityId: 3 });
  assert.equal(result.ok, false);
  assert.equal(sessionChecked, false);
});

test("우선순위 id 가 목록에 없으면 거부한다", async () => {
  const tracker = fakeDeps();
  const result = await createSrHandler(tracker.deps, "acme", { subject: "제목", content: "내용", priorityId: 999 });
  assert.equal(result.ok, false);
});

test("세션이 없으면 code=session 을 돌려주고 감사 로그에 failed:session 을 남긴다", async () => {
  const { file, cleanup } = tempDb();
  try {
    const tracker = fakeDeps({ hasSession: false, dbFile: file });
    const result = await createSrHandler(tracker.deps, "acme", { subject: "제목", content: "내용", priorityId: 3 });
    assert.deepEqual(result, {
      ok: false, code: "session", message: "세션이 없습니다. SR 페이지에서 로그인하세요.",
    });

    const db = openDb(file);
    try {
      const rows = listAudit(db);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.action, "create_sr");
      assert.equal(rows[0]?.result, "failed:session");
      assert.equal(rows[0]?.team_id, "acme");
    } finally { db.close(); }
  } finally { cleanup(); }
});

test("성공하면 감사 로그에 ok 와 새 requestId 가 남고, refreshOpenCases 가 그 팀으로 호출된다", async () => {
  const { file, cleanup } = tempDb();
  try {
    const tracker = fakeDeps({ dbFile: file });
    const result = await createSrHandler(tracker.deps, "acme", {
      subject: "제목", content: "내용", priorityId: 1, actor: "alice",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.requestId, 555);

    assert.deepEqual(tracker.refreshOpenCasesCalls, [{ teamId: "acme" }]);

    const db = openDb(file);
    try {
      const rows = listAudit(db);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.result, "ok");
      assert.equal(rows[0]?.request_id, 555);
      assert.equal(rows[0]?.actor, "alice");
      assert.equal(rows[0]?.team_id, "acme");
    } finally { db.close(); }
  } finally { cleanup(); }
});

test("createCase 가 실패를 돌려주면 감사 로그에 failed:<code> 가 남고 refresh 는 부르지 않는다", async () => {
  const { file, cleanup } = tempDb();
  try {
    const tracker = fakeDeps({
      dbFile: file,
      createCase: async () => ({ ok: false, code: "failed", message: "거절됨" }),
    });
    const result = await createSrHandler(tracker.deps, "acme", { subject: "제목", content: "내용", priorityId: 2 });
    assert.equal(result.ok, false);
    assert.equal(tracker.refreshOpenCasesCalls.length, 0);

    const db = openDb(file);
    try {
      const rows = listAudit(db);
      assert.equal(rows[0]?.result, "failed:failed");
    } finally { db.close(); }
  } finally { cleanup(); }
});

test("actor 를 생략하면 빈 문자열로 기록된다 (하위호환)", async () => {
  const { file, cleanup } = tempDb();
  try {
    const tracker = fakeDeps({ dbFile: file });
    await createSrHandler(tracker.deps, "acme", { subject: "제목", content: "내용", priorityId: 3 });
    const db = openDb(file);
    try {
      assert.equal(listAudit(db)[0]?.actor, "");
    } finally { db.close(); }
  } finally { cleanup(); }
});

// ── reply ───────────────────────────────────────────────────────────

test("내용이 비면 즉시 거부한다", async () => {
  const tracker = fakeDeps();
  const result = await replyHandler(tracker.deps, "acme", { requestId: 1, text: "" });
  assert.equal(result.ok, false);
});

test("케이스가 없으면(또는 다른 팀 소유면) not_found 를 돌려주고 감사 로그를 남긴다", async () => {
  const { file, cleanup } = tempDb();
  try {
    const tracker = fakeDeps({ dbFile: file });
    const result = await replyHandler(tracker.deps, "acme", { requestId: 999, text: "답변" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "not_found");

    const db = openDb(file);
    try {
      assert.equal(listAudit(db)[0]?.result, "failed:not_found");
    } finally { db.close(); }
  } finally { cleanup(); }
});

test("종료된 케이스에는 답할 수 없다", async () => {
  const { db, file, cleanup } = tempDb();
  try {
    upsertCase(db, sampleCase(1, "Closed", "acme"));
    const tracker = fakeDeps({ dbFile: file });
    const result = await replyHandler(tracker.deps, "acme", { requestId: 1, text: "답변" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "closed");
  } finally { cleanup(); }
});

test("세션이 없으면 code=session 을 돌려준다", async () => {
  const { db, file, cleanup } = tempDb();
  try {
    upsertCase(db, sampleCase(1, "Open", "acme"));
    const tracker = fakeDeps({ hasSession: false, dbFile: file });
    const result = await replyHandler(tracker.deps, "acme", { requestId: 1, text: "답변" });
    assert.deepEqual(result, {
      ok: false, code: "session", message: "세션이 없습니다. SR 페이지에서 로그인하세요.",
    });
  } finally { cleanup(); }
});

test("성공하면 감사 로그에 ok 가 남고 refreshCaseThreads 가 그 requestId 로 호출된다", async () => {
  const { db, file, cleanup } = tempDb();
  try {
    upsertCase(db, sampleCase(1, "Open", "acme"));
    const tracker = fakeDeps({ dbFile: file });
    const result = await replyHandler(tracker.deps, "acme", { requestId: 1, text: "답변", actor: "bob" });
    assert.equal(result.ok, true);

    assert.deepEqual(tracker.refreshCaseThreadsCalls, [{ requestId: 1 }]);

    const rows = listAudit(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.result, "ok");
    assert.equal(rows[0]?.request_id, 1);
    assert.equal(rows[0]?.actor, "bob");
  } finally { cleanup(); }
});

test("postReply 가 실패를 돌려주면 failed:<code> 로 기록되고 refresh 는 부르지 않는다", async () => {
  const { db, file, cleanup } = tempDb();
  try {
    upsertCase(db, sampleCase(1, "Open", "acme"));
    const tracker = fakeDeps({
      dbFile: file,
      postReply: async () => ({ ok: false, code: "version", message: "충돌" }),
    });
    const result = await replyHandler(tracker.deps, "acme", { requestId: 1, text: "답변" });
    assert.equal(result.ok, false);
    assert.equal(tracker.refreshCaseThreadsCalls.length, 0);

    const rows = listAudit(db);
    assert.equal(rows[0]?.result, "failed:version");
  } finally { cleanup(); }
});

test("persist 가 실패해도(runSideEffect 가 삼킨다) 성공 응답과 감사 로그는 흔들리지 않는다", async () => {
  const { db, file, cleanup } = tempDb();
  try {
    upsertCase(db, sampleCase(1, "Open", "acme"));
    const throwingClient = {
      get: async () => { throw new Error("unused"); },
      post: async () => { throw new Error("unused"); },
      persist: () => { throw new Error("디스크 문제"); },
    };
    const tracker = fakeDeps({ dbFile: file, fetchClient: () => throwingClient });
    const result = await replyHandler(tracker.deps, "acme", { requestId: 1, text: "답변" });
    assert.equal(result.ok, true);
    assert.equal(listAudit(db)[0]?.result, "ok");
  } finally { cleanup(); }
});
