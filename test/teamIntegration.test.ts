import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TEAM_ID } from "../lib/config.ts";
import { openDb, upsertTeam } from "../lib/db.ts";
import { MissingSecretKeyError } from "../lib/secretBox.ts";
import {
  deleteIntegration,
  getIntegration,
  listIntegrations,
  upsertIntegration,
} from "../lib/teamIntegration.ts";

async function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "srhub-integration-"));
  const db = await openDb(join(dir, "test.db"));
  return { db, cleanup: async () => { await db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** SR_SECRET_KEY 를 테스트 동안만 바꾸고 원래 값으로 되돌린다. */
async function withKey<T>(key: string | undefined, fn: () => Promise<T> | T): Promise<T> {
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

test("upsert 후 getIntegration 으로 복호화된 값을 읽을 수 있다 (왕복)", async () => {
  const { db, cleanup } = await tempDb();
  try {
    await withKey(KEY, async () => {
      await upsertIntegration(db, {
        teamId: DEFAULT_TEAM_ID, kind: "jira",
        baseUrl: "https://example.atlassian.net/", project: "ABC", secret: "tok-123",
      });
      const got = await getIntegration(db, DEFAULT_TEAM_ID, "jira");
      assert.ok(got);
      assert.equal(got?.secret, "tok-123");
      assert.equal(got?.baseUrl, "https://example.atlassian.net"); // 끝 슬래시 제거됨
      assert.equal(got?.project, "ABC");
    });
  } finally { await cleanup(); }
});

test("SR_SECRET_KEY 가 없으면 토큰이 있는 저장을 거부한다 (평문 저장 금지, 부분 저장도 없음)", async () => {
  const { db, cleanup } = await tempDb();
  try {
    await withKey(undefined, async () => {
      await assert.rejects(
        async () => await upsertIntegration(db, {
          teamId: DEFAULT_TEAM_ID, kind: "jira",
          baseUrl: "https://example.atlassian.net", project: "ABC", secret: "tok-123",
        }),
        MissingSecretKeyError,
      );
    });
    const rows = await db.all("SELECT * FROM team_integrations");
    assert.equal(rows.length, 0);
  } finally { await cleanup(); }
});

test("secret 없이(빈 값) 저장하는 것은 허용된다 — 키가 없어도 등록만은 가능하다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    await withKey(undefined, async () => {
      await assert.doesNotReject(async () => await upsertIntegration(db, {
        teamId: DEFAULT_TEAM_ID, kind: "jira",
        baseUrl: "https://example.atlassian.net", project: "ABC", secret: "",
      }));
    });
    assert.equal((await listIntegrations(db, DEFAULT_TEAM_ID))[0]?.hasSecret, false);
  } finally { await cleanup(); }
});

test("secret 을 비워 두고 수정하면 기존 토큰이 유지된다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    await withKey(KEY, async () => {
      await upsertIntegration(db, {
        teamId: DEFAULT_TEAM_ID, kind: "jira",
        baseUrl: "https://a.atlassian.net", project: "ABC", secret: "tok-1",
      });
      await upsertIntegration(db, {
        teamId: DEFAULT_TEAM_ID, kind: "jira",
        baseUrl: "https://a.atlassian.net", project: "XYZ", secret: "",
      });
      const got = await getIntegration(db, DEFAULT_TEAM_ID, "jira");
      assert.equal(got?.secret, "tok-1");
      assert.equal(got?.project, "XYZ");
    });
  } finally { await cleanup(); }
});

test("listIntegrations 는 평문·암호문을 노출하지 않고 존재 여부만 돌려준다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    await withKey(KEY, async () => {
      await upsertIntegration(db, {
        teamId: DEFAULT_TEAM_ID, kind: "jira",
        baseUrl: "https://a.atlassian.net", project: "ABC", secret: "super-secret-token",
      });
    });
    const list = await listIntegrations(db, DEFAULT_TEAM_ID);
    assert.equal(list.length, 1);
    const meta = list[0]!;
    assert.equal(meta.hasSecret, true);
    assert.equal(meta.kind, "jira");
    assert.ok(!("secret" in meta));
    assert.ok(!("secret_enc" in meta));

    const serialized = JSON.stringify(meta);
    assert.ok(!serialized.includes("super-secret-token"));

    const rawRow = await db.get(
      "SELECT secret_enc FROM team_integrations WHERE team_id = ? AND kind = 'jira'",
      [DEFAULT_TEAM_ID],
    ) as { secret_enc: string };
    assert.ok(!serialized.includes(rawRow.secret_enc));
  } finally { await cleanup(); }
});

test("토큰 없이도 등록할 수 있고(hasSecret=false), 이후 토큰을 추가할 수 있다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    await upsertIntegration(db, {
      teamId: DEFAULT_TEAM_ID, kind: "jira",
      baseUrl: "https://a.atlassian.net", project: "ABC", secret: "",
    });
    assert.equal((await listIntegrations(db, DEFAULT_TEAM_ID))[0]?.hasSecret, false);

    await withKey(KEY, async () => {
      await upsertIntegration(db, {
        teamId: DEFAULT_TEAM_ID, kind: "jira",
        baseUrl: "https://a.atlassian.net", project: "ABC", secret: "later-token",
      });
    });
    assert.equal((await listIntegrations(db, DEFAULT_TEAM_ID))[0]?.hasSecret, true);
  } finally { await cleanup(); }
});

test("getIntegration 은 없는 연동에 대해 null 을 돌려준다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    assert.equal(await getIntegration(db, DEFAULT_TEAM_ID, "jira"), null);
  } finally { await cleanup(); }
});

test("deleteIntegration 은 해당 팀·kind 행만 지운다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    await upsertTeam(db, { team_id: "acme", team_name: "Acme", broadcom_username: "" });
    await withKey(KEY, async () => {
      await upsertIntegration(db, {
        teamId: DEFAULT_TEAM_ID, kind: "jira", baseUrl: "https://a.atlassian.net", project: "A", secret: "t1",
      });
      await upsertIntegration(db, {
        teamId: "acme", kind: "jira", baseUrl: "https://b.atlassian.net", project: "B", secret: "t2",
      });
    });
    await deleteIntegration(db, DEFAULT_TEAM_ID, "jira");
    assert.equal((await listIntegrations(db, DEFAULT_TEAM_ID)).length, 0);
    assert.equal((await listIntegrations(db, "acme")).length, 1);
  } finally { await cleanup(); }
});

test("존재하지 않는 연동을 지워도 조용히 반환한다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    await assert.doesNotReject(async () => await deleteIntegration(db, DEFAULT_TEAM_ID, "jira"));
  } finally { await cleanup(); }
});

test("잘못된 형식의 teamId(경로 탈출 시도)는 거부한다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    await assert.rejects(async () => await upsertIntegration(db, {
      teamId: "../x", kind: "jira", baseUrl: "https://a.atlassian.net", project: "A", secret: "",
    }));
    await assert.rejects(async () => await listIntegrations(db, "../x"));
    await assert.rejects(async () => await getIntegration(db, "../x", "jira"));
  } finally { await cleanup(); }
});

test("존재하지 않는 팀으로는 등록을 거부한다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    await assert.rejects(async () => await upsertIntegration(db, {
      teamId: "no-such-team", kind: "jira", baseUrl: "https://a.atlassian.net", project: "A", secret: "",
    }));
  } finally { await cleanup(); }
});

test("잘못된 형식의 kind 는 거부한다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    await assert.rejects(async () => await upsertIntegration(db, {
      teamId: DEFAULT_TEAM_ID, kind: "Jira!", baseUrl: "https://a.atlassian.net", project: "A", secret: "",
    }));
  } finally { await cleanup(); }
});

test("잘못된 base_url(http, 형식오류)은 거부한다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    await assert.rejects(async () => await upsertIntegration(db, {
      teamId: DEFAULT_TEAM_ID, kind: "jira", baseUrl: "http://a.atlassian.net", project: "A", secret: "",
    }));
    await assert.rejects(async () => await upsertIntegration(db, {
      teamId: DEFAULT_TEAM_ID, kind: "jira", baseUrl: "not-a-url", project: "A", secret: "",
    }));
  } finally { await cleanup(); }
});

test("project 가 비어 있으면(공백만) 거부한다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    await assert.rejects(async () => await upsertIntegration(db, {
      teamId: DEFAULT_TEAM_ID, kind: "jira", baseUrl: "https://a.atlassian.net", project: "  ", secret: "",
    }));
  } finally { await cleanup(); }
});

test("서로 다른 팀은 같은 kind 를 독립적으로 저장한다", async () => {
  const { db, cleanup } = await tempDb();
  try {
    await upsertTeam(db, { team_id: "acme", team_name: "Acme", broadcom_username: "" });
    await withKey(KEY, async () => {
      await upsertIntegration(db, {
        teamId: DEFAULT_TEAM_ID, kind: "jira", baseUrl: "https://a.atlassian.net", project: "A", secret: "t1",
      });
      await upsertIntegration(db, {
        teamId: "acme", kind: "jira", baseUrl: "https://b.atlassian.net", project: "B", secret: "t2",
      });

      assert.equal((await getIntegration(db, DEFAULT_TEAM_ID, "jira"))?.secret, "t1");
      assert.equal((await getIntegration(db, "acme", "jira"))?.secret, "t2");
    });
  } finally { await cleanup(); }
});
