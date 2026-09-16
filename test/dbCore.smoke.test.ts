/**
 * DB 추상화 스모크 테스트.
 *
 * 스키마 적용 + 기본 CRUD + ON CONFLICT + insertReturning + 트랜잭션 롤백을
 * SQLite 와 Postgres 양쪽에서 같은 코드로 검증한다. 방언 어댑터가 실제로 호환되는지
 * 포팅 전에 확인하는 것이 목적이다.
 *
 * Postgres 부분은 SR_TEST_PG(연결 문자열)가 있을 때만 돈다 — 없으면 skip.
 * SQLite 부분은 항상 돈다(무설정).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schemaSqlFor } from "../lib/schema.ts";
import { createDb, closeAllPools, type Db } from "../lib/dbCore.ts";

async function exercise(db: Db): Promise<void> {
  await db.exec(schemaSqlFor(db.dialect));

  const teamId = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  // ON CONFLICT DO NOTHING — 두 번 넣어도 한 행 (두 엔진 공통 문법)
  const insertTeam =
    "INSERT INTO teams (team_id, team_name, broadcom_username, created_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING";
  await db.run(insertTeam, [teamId, "스모크", "u@x", "2026-09-16T00:00:00.000Z"]);
  await db.run(insertTeam, [teamId, "스모크", "u@x", "2026-09-16T00:00:00.000Z"]);

  const team = await db.get<{ team_name: string }>("SELECT team_name FROM teams WHERE team_id = ?", [teamId]);
  assert.equal(team?.team_name, "스모크");

  const count = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM teams WHERE team_id = ?", [teamId]);
  assert.equal(Number(count?.n), 1, "ON CONFLICT 로 중복 생성되지 않아야 한다");

  // insertReturning — AUTOINCREMENT/IDENTITY 로 생성된 id 를 받는다
  const runId = await db.insertReturning(
    "INSERT INTO runs (started_at, status) VALUES (?, ?)",
    ["2026-09-16T00:00:00.000Z", "success"],
    "run_id",
  );
  assert.ok(Number.isFinite(runId) && runId > 0, `run_id 를 받아야 한다: ${runId}`);

  const run = await db.get<{ status: string }>("SELECT status FROM runs WHERE run_id = ?", [runId]);
  assert.equal(run?.status, "success");

  // 트랜잭션 롤백 — 던지면 되돌린다
  const rollbackTeam = `${teamId}-rb`;
  await assert.rejects(
    db.tx(async (tx) => {
      await tx.run(insertTeam, [rollbackTeam, "롤백대상", "u@x", "2026-09-16T00:00:00.000Z"]);
      throw new Error("의도적 실패");
    }),
    /의도적 실패/,
  );
  const gone = await db.get("SELECT team_id FROM teams WHERE team_id = ?", [rollbackTeam]);
  assert.equal(gone, undefined, "롤백되어 남지 않아야 한다");

  // 정리
  await db.run("DELETE FROM runs WHERE run_id = ?", [runId]);
  await db.run("DELETE FROM teams WHERE team_id = ?", [teamId]);
}

test("SQLite: 스키마·CRUD·ON CONFLICT·insertReturning·tx 롤백", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "dbcore-")), "sr.db");
  const db = createDb({ dialect: "sqlite", file });
  try {
    await exercise(db);
  } finally {
    await db.close();
  }
});

const PG = process.env.SR_TEST_PG;
test("Postgres: 스키마·CRUD·ON CONFLICT·insertReturning·tx 롤백", { skip: PG ? false : "SR_TEST_PG 없음" }, async () => {
  const db = createDb({ dialect: "postgres", connectionString: PG });
  await exercise(db);
});

after(async () => {
  await closeAllPools();
});
