/**
 * DB 백엔드 결정(resolveDbTarget)의 우선순위 검증.
 *
 * 핵심 회귀 방지: TAS 의 Postgres 서비스 바인딩이 기동 직전 .profile.d 로 DATABASE_URL 을
 * "그 앱 전용 VCAP 롤" URL 로 덮어쓴다. 그래서 우리가 지정한 고정 전용 계정을 쓰려면
 * 플랫폼이 안 건드리는 SR_DATABASE_URL 이 DATABASE_URL·VCAP 보다 반드시 먼저여야 한다.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveDbTarget } from "../lib/dbConn.ts";

const KEYS = ["SR_DATABASE_URL", "DATABASE_URL", "VCAP_SERVICES", "SR_PG_SCHEMA", "SR_DB_FILE"] as const;
const saved = new Map<string, string | undefined>();

const OVERRIDE = "postgres://paasops:pw@ovr-host:5432/postgres";
const PLATFORM = "postgres://36b6f903:pw@vcap-host:5432/postgres";
const VCAP = JSON.stringify({
  postgres: [{ credentials: { uri: "postgres://vcaprole:pw@vcap-broker:5432/postgres" } }],
});

beforeEach(() => {
  for (const k of KEYS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("SR_DATABASE_URL 이 DATABASE_URL·VCAP 보다 우선한다", () => {
  process.env.SR_DATABASE_URL = OVERRIDE;
  process.env.DATABASE_URL = PLATFORM; // 플랫폼이 덮어쓴 VCAP 롤 URL 을 흉내
  process.env.VCAP_SERVICES = VCAP;
  const t = resolveDbTarget();
  assert.equal(t.dialect, "postgres");
  assert.equal(t.connectionString, OVERRIDE);
});

test("SR_DATABASE_URL 이 없으면 DATABASE_URL 을 쓴다", () => {
  process.env.DATABASE_URL = PLATFORM;
  process.env.VCAP_SERVICES = VCAP;
  const t = resolveDbTarget();
  assert.equal(t.connectionString, PLATFORM);
});

test("URL 계열이 모두 없으면 VCAP 바인딩을 쓴다", () => {
  process.env.VCAP_SERVICES = VCAP;
  const t = resolveDbTarget();
  assert.equal(t.dialect, "postgres");
  assert.match(t.connectionString ?? "", /vcaprole/);
});

test("SR_DATABASE_URL 이 postgres 형식이 아니면 무시하고 다음으로 넘어간다", () => {
  process.env.SR_DATABASE_URL = "not-a-db-url";
  process.env.DATABASE_URL = PLATFORM;
  const t = resolveDbTarget();
  assert.equal(t.connectionString, PLATFORM);
});

test("아무 것도 없으면 SQLite 로 떨어진다", () => {
  const t = resolveDbTarget();
  assert.equal(t.dialect, "sqlite");
  assert.ok((t.file ?? "").length > 0);
});

test("postgres 대상은 schema(pgSchema) 를 함께 실어 준다", () => {
  process.env.SR_DATABASE_URL = OVERRIDE;
  process.env.SR_PG_SCHEMA = "paasops";
  const t = resolveDbTarget();
  assert.equal(t.schema, "paasops");
});
