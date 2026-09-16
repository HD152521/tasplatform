/**
 * 헬스체크 순수 로직(lib/health) + 라우트 조회 경로 테스트.
 *
 * 밀폐(hermetic): 순수 함수는 값만 검증하고, DB 경로는 임시 SQLite openDb 로 확인한다
 * (실제 네트워크·Postgres 없이). next/server 는 끌어오지 않는다 — 라우트가 값을 만드는 데
 * 쓰는 조회+조립 로직만 여기서 재현한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isoNow } from "../lib/dates.ts";
import { listTeams, openDb } from "../lib/db.ts";
import { healthError, healthOk, summarizeHealthError } from "../lib/health.ts";

test("healthOk 는 방언·팀수·시각만 담는다", () => {
  const status = healthOk("sqlite", 3, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(status, {
    ok: true,
    dialect: "sqlite",
    teams: 3,
    at: "2026-01-01T00:00:00.000Z",
  });
});

test("summarizeHealthError 는 원인별 고정 코드로 환원한다", () => {
  assert.equal(summarizeHealthError(new Error("Connection terminated due to timeout")), "db_timeout");
  assert.equal(summarizeHealthError(new Error("getaddrinfo ENOTFOUND db.internal")), "db_unreachable");
  assert.equal(summarizeHealthError(new Error("connect ECONNREFUSED 10.0.0.1:5432")), "db_unreachable");
  assert.equal(
    summarizeHealthError(new Error('password authentication failed for user "svc_sr"')),
    "db_auth_failed",
  );
  assert.equal(summarizeHealthError(new Error("something odd")), "db_error");
  assert.equal(summarizeHealthError("plain string"), "db_error");
});

test("요약 코드에 호스트·계정·포트가 새지 않는다", () => {
  const leaky = new Error(
    'connect ECONNREFUSED postgres://svc_sr:s3cr3t@db.internal.example:5432/srdb (search_path=sr_app)',
  );
  const code = summarizeHealthError(leaky);
  for (const secret of ["db.internal", "svc_sr", "s3cr3t", "5432", "srdb", "sr_app"]) {
    assert.equal(code.includes(secret), false, `요약 코드가 ${secret} 를 노출하면 안 된다`);
  }
});

test("healthError 는 { ok:false, error:<코드> } 형태다", () => {
  const status = healthError(new Error("getaddrinfo ENOTFOUND x"));
  assert.deepEqual(status, { ok: false, error: "db_unreachable" });
});

test("임시 SQLite 로 라우트 조회 경로가 성공 상태를 만든다", async () => {
  const db = await openDb(join(mkdtempSync(join(tmpdir(), "health-")), "sr.db"));
  try {
    const teams = await listTeams(db);
    const status = healthOk(db.dialect, teams.length, isoNow());
    assert.equal(status.ok, true);
    assert.equal(status.dialect, "sqlite");
    // openDb 가 기본 팀을 시드하므로 최소 1개는 있어야 한다.
    assert.ok(status.teams >= 1, "기본 팀이 시드되어 teams >= 1 이어야");
  } finally {
    await db.close();
  }
});
