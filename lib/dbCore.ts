/**
 * 비동기 DB 추상화. SQLite(로컬/테스트)와 Postgres(TAS)를 같은 인터페이스로 가린다.
 *
 * 왜 비동기인가: Postgres 드라이버(pg)는 네트워크 I/O 라 동기가 불가능하다. 그래서
 * 인터페이스를 async 로 두고, SQLite 어댑터는 node:sqlite 의 동기 결과를 Promise 로 감싼다.
 * 호출부는 전부 await 로 통일된다(방언에 상관없이 같은 코드).
 *
 * 방언 차이 처리:
 *   - 플레이스홀더: 소스는 '?' 를 쓰고, Postgres 는 $1,$2.. 로 치환한다.
 *   - AUTOINCREMENT / INTEGER: 스키마 단계에서 schemaSqlFor 가 치환한다.
 *   - lastInsertRowid: SQLite 는 run 결과에서, Postgres 는 RETURNING 으로 받는다
 *     (insertReturning).
 *   - BIGINT: pg 는 int8 을 기본으로 문자열로 준다 → 숫자로 파싱하도록 타입 파서를 건다.
 *
 * server-only 를 붙이지 않는다. 수집기(Node)에서도 쓴다.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import pg from "pg";
import type { Dialect, DbTarget } from "./dbConn.ts";

// pg 는 int8(BIGINT, oid 20)·numeric 을 정밀도 보존을 위해 문자열로 준다.
// 우리 id·카운트는 안전 정수 범위라 숫자로 파싱한다. (한 번만 걸면 프로세스 전역 적용)
pg.types.setTypeParser(20, (v: string | null) => (v === null ? null : Number(v)));

export interface Db {
  readonly dialect: Dialect;
  /** 한 행(없으면 undefined). */
  get<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T | undefined>;
  /** 여러 행. */
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** 쓰기. 변경 행수만 돌려준다. */
  run(sql: string, params?: readonly unknown[]): Promise<{ changes: number }>;
  /** INSERT 후 생성된 id 를 돌려준다(AUTOINCREMENT/IDENTITY 용). */
  insertReturning(sql: string, params: readonly unknown[], returningColumn: string): Promise<number>;
  /** DDL 등 파라미터 없는 다중 문장 실행. */
  exec(sql: string): Promise<void>;
  /** 트랜잭션. 콜백 안에서 던지면 롤백한다. */
  tx<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** '?' 플레이스홀더를 Postgres 의 $1,$2.. 로 바꾼다. (SQL 문자열에 리터럴 '?' 는 없다) */
function toPgPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${(i += 1)}`);
}

// ---------------------------------------------------------------------------
// SQLite 어댑터 — node:sqlite 의 동기 API 를 async 로 감싼다.
// ---------------------------------------------------------------------------
/** node:sqlite 가 바인딩으로 받는 값. 우리 파라미터(숫자·문자열·null 등)를 여기에 맞춘다. */
type SqliteParam = null | number | bigint | string | Uint8Array;
function toSqliteParams(params: readonly unknown[]): SqliteParam[] {
  return params as SqliteParam[];
}

class SqliteDb implements Db {
  readonly dialect: Dialect = "sqlite";
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  get<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    const row = this.db.prepare(sql).get(...toSqliteParams(params)) as T | undefined;
    return Promise.resolve(row);
  }

  all<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const rows = this.db.prepare(sql).all(...toSqliteParams(params)) as unknown as T[];
    return Promise.resolve(rows);
  }

  run(sql: string, params: readonly unknown[] = []): Promise<{ changes: number }> {
    const info = this.db.prepare(sql).run(...toSqliteParams(params));
    return Promise.resolve({ changes: Number(info.changes) });
  }

  insertReturning(sql: string, params: readonly unknown[], _returningColumn: string): Promise<number> {
    const info = this.db.prepare(sql).run(...toSqliteParams(params));
    return Promise.resolve(Number(info.lastInsertRowid));
  }

  exec(sql: string): Promise<void> {
    this.db.exec(sql);
    return Promise.resolve();
  }

  async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    this.db.exec("BEGIN");
    try {
      const result = await fn(this);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Postgres 어댑터 — 공유 풀(pool). 요청마다 열고 닫지 않는다.
// ---------------------------------------------------------------------------
type PgQueryable = Pick<pg.PoolClient, "query">;

class PostgresDb implements Db {
  readonly dialect: Dialect = "postgres";
  /** pool 이면 일반 질의, tx 안에서는 단일 client 로 감싼다(pool=null). */
  private readonly q: PgQueryable;
  private readonly pool: pg.Pool | null;
  constructor(q: PgQueryable, pool: pg.Pool | null) {
    this.q = q;
    this.pool = pool;
  }

  async get<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    const res = await this.q.query(toPgPlaceholders(sql), params as unknown[]);
    return (res.rows[0] as T | undefined) ?? undefined;
  }

  async all<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const res = await this.q.query(toPgPlaceholders(sql), params as unknown[]);
    return res.rows as T[];
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<{ changes: number }> {
    const res = await this.q.query(toPgPlaceholders(sql), params as unknown[]);
    return { changes: res.rowCount ?? 0 };
  }

  async insertReturning(sql: string, params: readonly unknown[], returningColumn: string): Promise<number> {
    const res = await this.q.query(`${toPgPlaceholders(sql)} RETURNING ${returningColumn}`, params as unknown[]);
    const row = res.rows[0] as Record<string, unknown> | undefined;
    return Number(row?.[returningColumn]);
  }

  async exec(sql: string): Promise<void> {
    // 파라미터 없는 다중 문장 — 단순 질의 프로토콜이 세미콜론 구분을 그대로 처리한다.
    await this.q.query(sql);
  }

  async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (!this.pool) {
      // 이미 tx 안(단일 client) 이면 중첩 없이 그대로 실행한다.
      return fn(this);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(new PostgresDb(client, null));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    // 공유 풀은 닫지 않는다(프로세스 수명 동안 유지). 실제 종료는 closeAllPools.
    return Promise.resolve();
  }
}

// connectionString -> 공유 Pool. 같은 문자열이면 재사용한다.
const pools = new Map<string, pg.Pool>();

function getPool(connectionString: string): pg.Pool {
  let pool = pools.get(connectionString);
  if (!pool) {
    pool = new pg.Pool({ connectionString, max: 10 });
    pools.set(connectionString, pool);
  }
  return pool;
}

/** 프로세스 종료·테스트 정리용. 모든 풀을 닫는다. */
export async function closeAllPools(): Promise<void> {
  const all = [...pools.values()];
  pools.clear();
  await Promise.all(all.map((p) => p.end()));
}

/** 대상(방언)에 맞는 Db 를 만든다. SQLite 는 파일별 새 핸들, Postgres 는 공유 풀. */
export function createDb(target: DbTarget): Db {
  if (target.dialect === "postgres") {
    const conn = target.connectionString ?? "";
    if (conn === "") throw new Error("Postgres connectionString 이 없습니다.");
    return new PostgresDb(getPool(conn), getPool(conn));
  }
  const file = target.file ?? "";
  if (file === "") throw new Error("SQLite file 경로가 없습니다.");
  const path = resolve(file);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return new SqliteDb(db);
}
