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
import { UNKNOWN_VERSION } from "../lib/buildVersion.ts";
import { healthError, healthOk, summarizeHealthError } from "../lib/health.ts";

test("healthOk 는 방언·팀수·시각·빌드커밋만 담는다", () => {
  const status = healthOk("sqlite", 3, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(status, {
    ok: true,
    dialect: "sqlite",
    teams: 3,
    at: "2026-01-01T00:00:00.000Z",
    // CI 를 안 거친 빌드(로컬·시험)는 unknown 이다 — 그럴듯한 값을 만들지 않는다.
    version: UNKNOWN_VERSION,
  });
});

test("빌드 커밋은 접속정보를 담지 않는다", () => {
  /*
   * 이 응답은 로그인 없이 누구나 볼 수 있다(배포 확인용). 커밋 해시는 레포를 볼 수
   * 있는 사람에게만 뜻이 있지만, 접속정보·계정이 섞이면 그건 유출이다.
   */
  const status = healthOk("postgres", 1, "2026-01-01T00:00:00.000Z");
  const text = JSON.stringify(status);
  for (const secret of ["postgres://", "password", "@", "5432"]) {
    assert.equal(text.includes(secret), false, `${secret} 가 응답에 있으면 안 된다`);
  }
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
  // 실패해도 **어느 빌드가 실패했는지**는 말해 준다 — 그게 없으면 진단이 또 헛돈다.
  assert.deepEqual(status, { ok: false, error: "db_unreachable", version: UNKNOWN_VERSION });
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
