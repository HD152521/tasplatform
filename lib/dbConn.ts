/**
 * DB 백엔드 결정.
 *
 * 우선순위:
 *   1) SR_DATABASE_URL 이 postgres:// 이면 Postgres (플랫폼이 덮어쓰는 DATABASE_URL 회피용)
 *   2) DATABASE_URL 이 postgres:// 이면 Postgres
 *   3) VCAP_SERVICES(TAS 바인딩)에서 Postgres 자격을 찾으면 Postgres
 *   4) 아니면 SQLite(로컬/테스트 기본 — 무설정)
 *
 * 이렇게 두면 로컬은 그대로 SQLite, TAS 는 바인딩만 하면 Postgres 를 쓴다.
 */
import { DB_FILE } from "./config.ts";

export type Dialect = "sqlite" | "postgres";

export interface DbTarget {
  dialect: Dialect;
  /** sqlite 전용 */
  file?: string;
  /** postgres 전용 */
  connectionString?: string;
  /** postgres 전용. 우리 테이블을 담을 전용 스키마(공유 DB 에서 이름 충돌·소유권 격리). */
  schema?: string;
}

const PG_SCHEMA_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 우리 앱 전용 Postgres 스키마. 공유 인스턴스에서 다른 앱과 테이블 이름이 겹치지 않도록
 * 별도 네임스페이스에 둔다. SR_PG_SCHEMA 미설정이면 public(기존 동작).
 * 식별자만 허용한다 — search_path/DDL 에 문자열로 들어가므로 주입을 막는다.
 */
export function pgSchema(): string {
  const raw = (process.env.SR_PG_SCHEMA ?? "").trim();
  if (raw === "") return "public";
  if (!PG_SCHEMA_PATTERN.test(raw) || raw.length > 63) {
    throw new Error(`SR_PG_SCHEMA 형식이 올바르지 않습니다(식별자만): ${JSON.stringify(raw)}`);
  }
  return raw;
}

interface VcapCredentials {
  uri?: string;
  url?: string;
  jdbcUrl?: string;
  hostname?: string;
  host?: string;
  port?: number | string;
  username?: string;
  user?: string;
  password?: string;
  dbname?: string;
  database?: string;
  name?: string;
}

function buildConnString(cred: VcapCredentials): string | null {
  const direct = cred.uri ?? cred.url;
  if (typeof direct === "string" && direct.startsWith("postgres")) return direct;

  const host = cred.hostname ?? cred.host;
  const user = cred.username ?? cred.user;
  const db = cred.dbname ?? cred.database ?? cred.name;
  if (!host || !user || !db) return null;
  const port = cred.port ?? 5432;
  const pass = cred.password ?? "";
  const auth = pass === "" ? encodeURIComponent(user) : `${encodeURIComponent(user)}:${encodeURIComponent(pass)}`;
  return `postgres://${auth}@${host}:${port}/${db}`;
}

/** VCAP_SERVICES(JSON)에서 첫 Postgres 자격을 찾는다. 라벨은 파운데이션마다 달라 전수 탐색한다. */
export function parseVcapPostgres(raw: string | undefined): string | null {
  if (!raw || raw.trim() === "") return null;
  let parsed: Record<string, Array<{ credentials?: VcapCredentials; tags?: string[]; label?: string }>>;
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return null;
  }

  for (const [label, instances] of Object.entries(parsed)) {
    if (!Array.isArray(instances)) continue;
    for (const inst of instances) {
      const cred = inst.credentials;
      if (!cred) continue;
      const looksPg =
        /postgres|psql|pg/i.test(label) ||
        (inst.tags ?? []).some((t) => /postgres|psql/i.test(t)) ||
        typeof cred.uri === "string" && cred.uri.startsWith("postgres");
      const conn = buildConnString(cred);
      if (conn && (looksPg || conn.startsWith("postgres"))) return conn;
    }
  }
  return null;
}

export function resolveDbTarget(): DbTarget {
  // SR_DATABASE_URL 을 최우선으로 본다.
  // 왜: TAS 의 Postgres 서비스 바인딩이 스테이징 때 .profile.d/ 스크립트를 만들어 기동 직전
  // DATABASE_URL 을 "그 앱 전용 VCAP 롤"의 URL 로 export 한다. 이건 우리가 cf set-env 로 넣은
  // 값(공유 DB 의 고정 전용 계정)을 매번 덮어써서, 앱마다 다른 롤로 붙어 서로의 테이블을
  // 소유권 때문에 못 읽는 문제를 일으킨다. 그래서 플랫폼이 절대 안 건드리는 전용 이름을 둔다.
  const override = (process.env.SR_DATABASE_URL ?? "").trim();
  if (override.startsWith("postgres")) {
    return { dialect: "postgres", connectionString: override, schema: pgSchema() };
  }

  const url = (process.env.DATABASE_URL ?? "").trim();
  if (url.startsWith("postgres")) return { dialect: "postgres", connectionString: url, schema: pgSchema() };

  const fromVcap = parseVcapPostgres(process.env.VCAP_SERVICES);
  if (fromVcap) return { dialect: "postgres", connectionString: fromVcap, schema: pgSchema() };

  return { dialect: "sqlite", file: (process.env.SR_DB_FILE ?? "").trim() || DB_FILE };
}
