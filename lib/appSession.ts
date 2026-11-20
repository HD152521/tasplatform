/**
 * 앱 로그인 세션 — 쿠키에 담는 토큰과 그 검증.
 *
 * **포털(브로드컴) 세션과 완전히 다른 것이다.** 포털 세션은 공용 계정으로 수집기가
 * 쓰는 것이고(`data/session.json`·`team_session_state`), 이건 "이 브라우저를 쓰는
 * 사람이 누구인가" 다. 같은 화면에 둘이 함께 보이므로 이름을 분명히 갈라 둔다.
 *
 * ## 평문 토큰을 저장하지 않는다
 *
 * DB 에는 SHA-256 해시만 넣는다. `team_tokens`(MCP 토큰)와 같은 방식이다 — DB 가
 * 새어도 그 값으로 로그인할 수 없다. 평문은 쿠키에만 있다.
 *
 * ## 왜 만료와 해지를 둘 다 두나
 *
 * - `expires_at` — 두고 잊은 브라우저가 영원히 열려 있지 않게.
 * - `revoked` — 로그아웃이 **즉시** 듣게. 쿠키를 지우는 것만으로는 이미 복사된
 *   토큰이 그대로 살아 있다.
 *
 * server-only 를 붙이지 않는다. 테스트와 스크립트에서도 부른다.
 */
import { createHash, randomBytes } from "node:crypto";
import { isoNow } from "./dates.ts";
import type { Db } from "./db.ts";
import { getUserWithTeam, touchLastLogin, type UserWithTeam } from "./users.ts";

/** 쿠키 이름. `sr_` 접두로 포털 쪽 쿠키와 섞이지 않게 한다. */
export const APP_SESSION_COOKIE = "sr_app_session";

/** 토큰 엔트로피. 32바이트 = 256비트. base64url 이라 쿠키에 그대로 담긴다. */
const TOKEN_BYTES = 32;

/** 기본 수명. 사내 도구이고 매일 쓰는 화면이라 길게 둔다. */
const DEFAULT_TTL_DAYS = 30;

/**
 * `last_seen_at` 을 너무 자주 쓰지 않기 위한 간격.
 *
 * 레이아웃이 **요청마다** 세션을 확인한다. 그때마다 UPDATE 를 날리면 페이지를 한 번
 * 보는 동안(HTML + 이미지 + 네비게이션) 쓰기가 여러 번 생긴다. 마지막 접속 시각은
 * 분 단위로 충분하다.
 */
const TOUCH_INTERVAL_MS = 10 * 60 * 1000;

function ttlDays(): number {
  const raw = (process.env.SR_APP_SESSION_DAYS ?? "").trim();
  if (raw === "") return DEFAULT_TTL_DAYS;
  const parsed = Number(raw);
  // Number("") === 0 함정을 위에서 막았고, 0·음수·NaN 은 기본값으로 되돌린다 —
  // 잘못 적은 값 때문에 전원이 매 요청 로그아웃되면 안 된다.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_DAYS;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface IssuedAppSession {
  /** 평문 토큰. 이 반환값이 유일한 노출 지점이다 — 쿠키로만 내보낸다. */
  readonly token: string;
  /** 쿠키 Max-Age 에 쓸 초. */
  readonly maxAgeSeconds: number;
  readonly expiresAt: string;
}

/** 로그인 성공 직후 세션 하나를 만든다. */
export async function createUserSession(db: Db, userId: number): Promise<IssuedAppSession> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const days = ttlDays();
  const expiresAtMs = Date.now() + days * 24 * 60 * 60 * 1000;
  const expiresAt = new Date(expiresAtMs).toISOString();

  await db.run(
    `INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at, last_seen_at, revoked)
     VALUES (?,?,?,?,?,0)`,
    [hashToken(token), userId, isoNow(), expiresAt, isoNow()],
  );
  await touchLastLogin(db, userId);

  return { token, maxAgeSeconds: Math.floor(days * 24 * 60 * 60), expiresAt };
}

/**
 * 토큰 → 사용자. 없음·해지·만료·사용자 없음은 전부 **null** 이다.
 *
 * 이유를 갈라 돌려주지 않는다 — 부르는 쪽이 할 일은 어느 경우든 같다(로그인 화면).
 * 만료된 행은 **지우지 않는다**: 같은 토큰으로 다시 들어오는 것이 "만료" 인지
 * "처음 보는 값" 인지 나중에 구분할 수 있어야 한다. 정리는 purgeExpiredSessions 가 한다.
 */
export async function resolveUserSession(
  db: Db,
  token: string | undefined | null,
): Promise<UserWithTeam | null> {
  if (!token) return null;

  const tokenHash = hashToken(token);
  const row = await db.get<{
    user_id: number;
    expires_at: string;
    last_seen_at: string;
    revoked: number;
  }>("SELECT user_id, expires_at, last_seen_at, revoked FROM user_sessions WHERE token_hash = ?", [
    tokenHash,
  ]);

  if (row === undefined) return null;
  if (Number(row.revoked) === 1) return null;

  const expiresMs = Date.parse(row.expires_at);
  // 날짜가 깨져 있으면(Number.isNaN) 만료로 본다. 읽을 수 없는 수명은 "무제한" 이 아니다.
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) return null;

  const user = await getUserWithTeam(db, Number(row.user_id));
  if (user === null || user.disabled) return null;

  const lastSeenMs = Date.parse(row.last_seen_at);
  if (!Number.isFinite(lastSeenMs) || Date.now() - lastSeenMs > TOUCH_INTERVAL_MS) {
    await db.run("UPDATE user_sessions SET last_seen_at = ? WHERE token_hash = ?", [
      isoNow(),
      tokenHash,
    ]);
  }

  return user;
}

/** 로그아웃. 존재하지 않아도 조용히 반환한다(멱등). */
export async function revokeUserSession(db: Db, token: string | undefined | null): Promise<void> {
  if (!token) return;
  await db.run("UPDATE user_sessions SET revoked = 1 WHERE token_hash = ?", [hashToken(token)]);
}

/** 그 사람의 모든 세션을 끊는다. 비밀번호를 바꿨을 때 부른다. */
export async function revokeAllUserSessions(db: Db, userId: number): Promise<void> {
  await db.run("UPDATE user_sessions SET revoked = 1 WHERE user_id = ?", [userId]);
}

/**
 * 만료·해지된 행 정리. 로그인할 때 곁다리로 부른다(별도 워커를 만들지 않는다).
 *
 * 해지된 행도 치우는 기준을 **만료 시각**으로 둔다 — 해지 직후 바로 지우면, 같은
 * 토큰으로 들어온 요청이 "해지됨" 이 아니라 "처음 보는 값" 이 되어 로그가 흐려진다.
 */
export async function purgeExpiredSessions(db: Db): Promise<number> {
  const result = await db.run("DELETE FROM user_sessions WHERE expires_at < ?", [isoNow()]);
  return result.changes;
}

export interface AppSessionMeta {
  readonly tokenHashPrefix: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastSeenAt: string;
  readonly revoked: boolean;
}

/** 그 사람의 세션 목록(화면용). 평문·전체 해시는 포함하지 않는다. */
export async function listUserSessions(db: Db, userId: number): Promise<AppSessionMeta[]> {
  const rows = await db.all<{
    token_hash: string;
    created_at: string;
    expires_at: string;
    last_seen_at: string;
    revoked: number;
  }>(
    `SELECT token_hash, created_at, expires_at, last_seen_at, revoked
       FROM user_sessions WHERE user_id = ? ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map((row) => ({
    tokenHashPrefix: row.token_hash.slice(0, 12),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    revoked: Number(row.revoked) === 1,
  }));
}
