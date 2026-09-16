import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TEAM_ID } from "../lib/config.ts";
import { openDb, type Db } from "../lib/db.ts";
import { issueTeamToken } from "../lib/teamToken.ts";
import {
  MAX_TOKEN_LENGTH,
  authenticateToken,
  extractBearerToken,
} from "../mcp/auth.ts";

async function tempDb(): Promise<{ db: Db; cleanup: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "srhub-mcp-auth-"));
  const db = await openDb(join(dir, "test.db"));
  return {
    db,
    cleanup: async () => {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ── extractBearerToken ─────────────────────────────────────────────

test("Bearer 형식에서 토큰만 뽑는다", () => {
  assert.equal(extractBearerToken("Bearer abc123"), "abc123");
});

test("대소문자를 가리지 않는다", () => {
  assert.equal(extractBearerToken("bearer abc123"), "abc123");
});

test("Bearer 접두가 없으면 null", () => {
  assert.equal(extractBearerToken("abc123"), null);
});

test("헤더가 없으면 null", () => {
  assert.equal(extractBearerToken(undefined), null);
  assert.equal(extractBearerToken(null), null);
});

test("헤더가 배열이면 첫 번째 값을 쓴다", () => {
  assert.equal(extractBearerToken(["Bearer abc123", "Bearer other"]), "abc123");
});

test("Bearer 뒤가 비어 있으면 null", () => {
  assert.equal(extractBearerToken("Bearer    "), null);
});

// ── authenticateToken ───────────────────────────────────────────────

test("유효한 토큰이면 teamId 를 돌려준다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    const issued = await issueTeamToken(db, DEFAULT_TEAM_ID, "챗봇");
    const result = await authenticateToken(db, `Bearer ${issued.token}`);
    assert.deepEqual(result, { ok: true, teamId: DEFAULT_TEAM_ID });
  } finally { await cleanup(); }
});

test("헤더가 없으면 401", async () => {
  const { db, cleanup } = await tempDb();
  try {
    const result = await authenticateToken(db, undefined);
    assert.equal(result.ok, false);
    assert.equal((result as { status: number }).status, 401);
  } finally { await cleanup(); }
});

test("무효한 토큰이면 401", async () => {
  const { db, cleanup } = await tempDb();
  try {
    const result = await authenticateToken(db, "Bearer not-a-real-token");
    assert.equal(result.ok, false);
  } finally { await cleanup(); }
});

test("해지된 토큰이면 401", async () => {
  const { db, cleanup } = await tempDb();
  try {
    const issued = await issueTeamToken(db, DEFAULT_TEAM_ID);
    await db.run("UPDATE team_tokens SET revoked = 1");
    const result = await authenticateToken(db, `Bearer ${issued.token}`);
    assert.equal(result.ok, false);
  } finally { await cleanup(); }
});

test("실패 사유는 세분화해 노출하지 않는다 (항상 같은 메시지)", async () => {
  const { db, cleanup } = await tempDb();
  try {
    const noHeader = await authenticateToken(db, undefined);
    const badToken = await authenticateToken(db, "Bearer garbage");
    assert.equal(noHeader.ok, false);
    assert.equal(badToken.ok, false);
    assert.equal(
      (noHeader as { message: string }).message,
      (badToken as { message: string }).message,
    );
  } finally { await cleanup(); }
});

test("길이 상한을 넘는 토큰은 거부하고, verify 함수를 아예 부르지 않는다 (해싱 DoS 방지)", async () => {
  const { db, cleanup } = await tempDb();
  try {
    const oversized = "a".repeat(MAX_TOKEN_LENGTH + 1);
    let verifyCalls = 0;
    const spyVerify = (_db: Db, _token: string) => {
      verifyCalls += 1;
      return null;
    };
    const result = await authenticateToken(db, `Bearer ${oversized}`, spyVerify);
    assert.equal(result.ok, false);
    assert.equal(verifyCalls, 0);
  } finally { await cleanup(); }
});

test("길이가 상한 이하인 토큰은 verify 함수를 정확히 한 번 부른다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    const issued = await issueTeamToken(db, DEFAULT_TEAM_ID);
    let verifyCalls = 0;
    const spyVerify = (_db: Db, token: string) => {
      verifyCalls += 1;
      assert.equal(token, issued.token);
      return { teamId: DEFAULT_TEAM_ID };
    };
    const result = await authenticateToken(db, `Bearer ${issued.token}`, spyVerify);
    assert.equal(verifyCalls, 1);
    assert.deepEqual(result, { ok: true, teamId: DEFAULT_TEAM_ID });
  } finally { await cleanup(); }
});

test("정확히 상한 길이인 토큰은 거부되지 않는다 (경계값)", async () => {
  const { db, cleanup } = await tempDb();
  try {
    const exact = "a".repeat(MAX_TOKEN_LENGTH);
    let verifyCalls = 0;
    const spyVerify = () => {
      verifyCalls += 1;
      return null;
    };
    await authenticateToken(db, `Bearer ${exact}`, spyVerify);
    assert.equal(verifyCalls, 1);
  } finally { await cleanup(); }
});
