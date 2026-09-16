/**
 * DB 백엔드 결정.
 *
 * 우선순위:
 *   1) DATABASE_URL 이 postgres:// 이면 Postgres
 *   2) VCAP_SERVICES(TAS 바인딩)에서 Postgres 자격을 찾으면 Postgres
 *   3) 아니면 SQLite(로컬/테스트 기본 — 무설정)
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
  const url = (process.env.DATABASE_URL ?? "").trim();
  if (url.startsWith("postgres")) return { dialect: "postgres", connectionString: url };

  const fromVcap = parseVcapPostgres(process.env.VCAP_SERVICES);
  if (fromVcap) return { dialect: "postgres", connectionString: fromVcap };

  return { dialect: "sqlite", file: (process.env.SR_DB_FILE ?? "").trim() || DB_FILE };
}
