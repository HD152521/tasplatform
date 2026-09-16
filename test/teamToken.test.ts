import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TEAM_ID } from "../lib/config.ts";
import { openDb, upsertTeam } from "../lib/db.ts";
import {
  issueTeamToken,
  listTeamTokens,
  revokeTeamToken,
  verifyTeamToken,
} from "../lib/teamToken.ts";

async function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "srhub-token-"));
  const db = await openDb(join(dir, "test.db"));
  return { db, cleanup: async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

test("발급한 토큰으로 검증하면 같은 팀 id 를 돌려준다 (왕복)", async () => {
  const { db, cleanup } = await tempDb();
  try {
    const issued = await issueTeamToken(db, DEFAULT_TEAM_ID, "테스트 라벨");
    const verified = await verifyTeamToken(db, issued.token);
    assert.deepEqual(verified, { teamId: DEFAULT_TEAM_ID });
  } finally { await cleanup(); }
});

test("잘못된(존재하지 않는) 토큰은 거부한다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    await issueTeamToken(db, DEFAULT_TEAM_ID);
    const verified = await verifyTeamToken(db, "not-a-real-token");
    assert.equal(verified, null);
  } finally { await cleanup(); }
});

test("빈 문자열 토큰은 거부한다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    assert.equal(await verifyTeamToken(db, ""), null);
  } finally { await cleanup(); }
});

test("해지된 토큰은 이후 검증에서 거부한다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    const issued = await issueTeamToken(db, DEFAULT_TEAM_ID);
    assert.ok(await verifyTeamToken(db, issued.token));

    await revokeTeamToken(db, issued.token);
    assert.equal(await verifyTeamToken(db, issued.token), null);
  } finally { await cleanup(); }
});

test("존재하지 않는 팀으로는 발급을 거부한다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    await assert.rejects(async () => { await issueTeamToken(db, "no-such-team"); });
  } finally { await cleanup(); }
});

test("잘못된 형식의 teamId(경로 탈출 시도)는 발급을 거부한다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    await assert.rejects(async () => { await issueTeamToken(db, "../x"); });
  } finally { await cleanup(); }
});

test("DB 에는 평문이 아니라 SHA-256 해시만 저장된다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    const issued = await issueTeamToken(db, DEFAULT_TEAM_ID);
    const rows = await db.all("SELECT token_hash FROM team_tokens") as Array<{ token_hash: string }>;

    assert.equal(rows.length, 1);
    // 저장된 값은 평문 토큰과 다르고, 평문의 SHA-256 해시와 일치해야 한다
    assert.notEqual(rows[0]?.token_hash, issued.token);
    assert.equal(rows[0]?.token_hash, sha256Hex(issued.token));
    // 평문이 DB 어디에도 부분 문자열로도 섞여 있지 않아야 한다
    assert.ok(!rows[0]?.token_hash.includes(issued.token));
  } finally { await cleanup(); }
});

test("listTeamTokens 는 평문·전체 해시를 노출하지 않고 메타만 돌려준다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    const issued = await issueTeamToken(db, DEFAULT_TEAM_ID, "설명용 라벨");
    const list = await listTeamTokens(db, DEFAULT_TEAM_ID);

    assert.equal(list.length, 1);
    const meta = list[0]!;
    assert.equal(meta.teamId, DEFAULT_TEAM_ID);
    assert.equal(meta.label, "설명용 라벨");
    assert.equal(meta.revoked, false);
    assert.equal(meta.lastUsedAt, null);

    const fullHash = sha256Hex(issued.token);
    // 접두만 있어야 하고, 전체 해시나 평문 전체를 포함해선 안 된다
    assert.ok(meta.tokenHashPrefix.length < fullHash.length);
    assert.equal(meta.tokenHashPrefix, fullHash.slice(0, meta.tokenHashPrefix.length));
    assert.notEqual(meta.tokenHashPrefix, fullHash);

    const serialized = JSON.stringify(meta);
    assert.ok(!serialized.includes(issued.token));
    assert.ok(!serialized.includes(fullHash));
  } finally { await cleanup(); }
});

test("verifyTeamToken 성공 시 last_used_at 이 갱신된다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    const issued = await issueTeamToken(db, DEFAULT_TEAM_ID);
    assert.equal((await listTeamTokens(db, DEFAULT_TEAM_ID))[0]?.lastUsedAt, null);

    await verifyTeamToken(db, issued.token);

    const after = (await listTeamTokens(db, DEFAULT_TEAM_ID))[0];
    assert.ok(after?.lastUsedAt);
  } finally { await cleanup(); }
});

test("서로 다른 팀의 토큰은 각자의 팀 id 로만 검증된다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    await upsertTeam(db, { team_id: "acme", team_name: "Acme", broadcom_username: "" });

    const defaultIssued = await issueTeamToken(db, DEFAULT_TEAM_ID);
    const acmeIssued = await issueTeamToken(db, "acme");

    assert.deepEqual(await verifyTeamToken(db, defaultIssued.token), { teamId: DEFAULT_TEAM_ID });
    assert.deepEqual(await verifyTeamToken(db, acmeIssued.token), { teamId: "acme" });
  } finally { await cleanup(); }
});

test("listTeamTokens 를 teamId 없이 부르면 전체 팀의 토큰을 돌려준다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    await upsertTeam(db, { team_id: "acme", team_name: "Acme", broadcom_username: "" });
    await issueTeamToken(db, DEFAULT_TEAM_ID);
    await issueTeamToken(db, "acme");

    const all = await listTeamTokens(db);
    assert.equal(all.length, 2);
    const teamIds = all.map((t) => t.teamId).sort();
    assert.deepEqual(teamIds, ["acme", DEFAULT_TEAM_ID].sort());
  } finally { await cleanup(); }
});

test("해지하지 않은 다른 팀의 토큰은 영향받지 않는다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    await upsertTeam(db, { team_id: "acme", team_name: "Acme", broadcom_username: "" });
    const defaultIssued = await issueTeamToken(db, DEFAULT_TEAM_ID);
    const acmeIssued = await issueTeamToken(db, "acme");

    await revokeTeamToken(db, defaultIssued.token);

    assert.equal(await verifyTeamToken(db, defaultIssued.token), null);
    assert.deepEqual(await verifyTeamToken(db, acmeIssued.token), { teamId: "acme" });
  } finally { await cleanup(); }
});
