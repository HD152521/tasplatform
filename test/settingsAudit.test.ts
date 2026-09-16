/**
 * app/api/settings/route.ts 의 감사 로그 부분을 검증한다.
 *
 * route.ts 는 "next/server" 를 임포트하므로 이 모듈을 node --test 에서 직접 불러올 수 없다
 * (Next 번들러 모듈 해석이 필요 — 실측 확인. lib/requestAudit.ts 의 같은 문제와 동일한 이유).
 * 그래서 route.ts 의 POST/DELETE 가 실제로 호출하는 것과 동일한 시퀀스
 * (upsertIntegration/deleteIntegration → recordAudit)를 여기서 그대로 재현해 검증한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TEAM_ID } from "../lib/config.ts";
import { listAudit, openDb, recordAudit } from "../lib/db.ts";
import { MissingSecretKeyError } from "../lib/secretBox.ts";
import { deleteIntegration, upsertIntegration } from "../lib/teamIntegration.ts";

type Db = Awaited<ReturnType<typeof openDb>>;

async function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "srhub-settings-audit-"));
  const db = await openDb(join(dir, "test.db"));
  return { db, cleanup: async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function withKey<T>(key: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const prev = process.env.SR_SECRET_KEY;
  if (key === undefined) delete process.env.SR_SECRET_KEY;
  else process.env.SR_SECRET_KEY = key;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.SR_SECRET_KEY;
    else process.env.SR_SECRET_KEY = prev;
  }
}

const KEY = randomBytes(32).toString("base64");

/** route.ts POST 핸들러가 성공 시 하는 것과 동일한 시퀀스. */
async function postUpsert(
  db: Db,
  args: { actor: string; teamId: string; kind: string; baseUrl: string; project: string; secret: string },
): Promise<void> {
  try {
    await upsertIntegration(db, {
      teamId: args.teamId, kind: args.kind, baseUrl: args.baseUrl,
      project: args.project, secret: args.secret,
    });
    await recordAudit(db, {
      actor: args.actor, teamId: args.teamId, action: "integration_upsert",
      requestId: null, result: "ok", detail: `kind=${args.kind}`,
    });
  } catch (error) {
    const code = error instanceof MissingSecretKeyError ? "no_key" : "error";
    await recordAudit(db, {
      actor: args.actor, teamId: args.teamId, action: "integration_upsert",
      requestId: null, result: `failed:${code}`, detail: `kind=${args.kind}`,
    });
    throw error;
  }
}

/** route.ts DELETE 핸들러가 하는 것과 동일한 시퀀스. */
async function deleteWithAudit(
  db: Db,
  args: { actor: string; teamId: string; kind: string },
): Promise<void> {
  await deleteIntegration(db, args.teamId, args.kind);
  await recordAudit(db, {
    actor: args.actor, teamId: args.teamId, action: "integration_delete",
    requestId: null, result: "ok", detail: `kind=${args.kind}`,
  });
}

test("연동 등록 성공 시 audit_log 에 action=integration_upsert, team_id, result=ok 가 남는다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    await withKey(KEY, async () => {
      await postUpsert(db, {
        actor: "user@corp.com", teamId: DEFAULT_TEAM_ID, kind: "jira",
        baseUrl: "https://a.atlassian.net", project: "ABC", secret: "super-secret-token",
      });
    });
    const rows = await listAudit(db, 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.action, "integration_upsert");
    assert.equal(rows[0]?.team_id, DEFAULT_TEAM_ID);
    assert.equal(rows[0]?.actor, "user@corp.com");
    assert.equal(rows[0]?.result, "ok");
    assert.equal(rows[0]?.request_id, null);
  } finally { await cleanup(); }
});

test("actor 를 안 보내면 빈 문자열로 기록된다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    await withKey(KEY, async () => {
      await postUpsert(db, {
        actor: "", teamId: DEFAULT_TEAM_ID, kind: "jira",
        baseUrl: "https://a.atlassian.net", project: "ABC", secret: "tok",
      });
    });
    assert.equal((await listAudit(db, 10))[0]?.actor, "");
  } finally { await cleanup(); }
});

test("SR_SECRET_KEY 가 없어 저장이 실패하면 result=failed:no_key 로 남는다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    await withKey(undefined, async () => {
      await assert.rejects(async () => postUpsert(db, {
        actor: "user@corp.com", teamId: DEFAULT_TEAM_ID, kind: "jira",
        baseUrl: "https://a.atlassian.net", project: "ABC", secret: "tok",
      }));
    });
    const rows = await listAudit(db, 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.result, "failed:no_key");
    assert.equal(rows[0]?.action, "integration_upsert");
  } finally { await cleanup(); }
});

test("존재하지 않는 팀이라 저장이 실패하면 result=failed:error 로 남는다", async () => {
  // route.ts 는 teamId 형식만 미리 검증하고(정규식 통과), 팀 존재 여부는
  // upsertIntegration 내부(getTeam)에서 걸러진다 — 형식은 맞지만 없는 팀인 경우를 재현한다.
  const { db, cleanup } = await tempDb();
  try {
    await withKey(KEY, async () => {
      await assert.rejects(async () => postUpsert(db, {
        actor: "user@corp.com", teamId: "ghost-team", kind: "jira",
        baseUrl: "https://a.atlassian.net", project: "ABC", secret: "tok",
      }));
    });
    const rows = await listAudit(db, 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.result, "failed:error");
    assert.equal(rows[0]?.team_id, "ghost-team");
  } finally { await cleanup(); }
});

test("연동 삭제 시 audit_log 에 action=integration_delete, team_id, result=ok 가 남는다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    await withKey(KEY, async () => {
      await postUpsert(db, {
        actor: "user@corp.com", teamId: DEFAULT_TEAM_ID, kind: "jira",
        baseUrl: "https://a.atlassian.net", project: "ABC", secret: "tok",
      });
    });
    await deleteWithAudit(db, { actor: "user2@corp.com", teamId: DEFAULT_TEAM_ID, kind: "jira" });

    const rows = await listAudit(db, 10);
    const deleteRow = rows.find((r) => r.action === "integration_delete");
    assert.ok(deleteRow);
    assert.equal(deleteRow?.team_id, DEFAULT_TEAM_ID);
    assert.equal(deleteRow?.actor, "user2@corp.com");
    assert.equal(deleteRow?.result, "ok");
  } finally { await cleanup(); }
});

test("audit detail 에는 kind 만 남고 base_url·secret 값은 절대 들어가지 않는다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    const secretValue = "super-secret-token-xyz";
    const baseUrlValue = "https://very-specific-domain.atlassian.net";
    await withKey(KEY, async () => {
      await postUpsert(db, {
        actor: "user@corp.com", teamId: DEFAULT_TEAM_ID, kind: "jira",
        baseUrl: baseUrlValue, project: "ABC", secret: secretValue,
      });
    });
    await deleteWithAudit(db, { actor: "user@corp.com", teamId: DEFAULT_TEAM_ID, kind: "jira" });

    const rows = await listAudit(db, 10);
    assert.ok(rows.length >= 2);
    for (const row of rows) {
      assert.equal(row.detail, "kind=jira");
      const serialized = JSON.stringify(row);
      assert.ok(!serialized.includes(secretValue));
      assert.ok(!serialized.includes(baseUrlValue));
    }
  } finally { await cleanup(); }
});
