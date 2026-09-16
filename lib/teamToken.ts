/**
 * 팀별 MCP 접속 토큰 발급·검증·해지 계층.
 *
 * Step 4(MCP 서버)가 이 계층을 써서 "이 연결이 어느 팀인지"를 확정하고
 * 무효 토큰(없음/변조/해지됨)을 거부한다.
 *
 * 보안 원칙:
 * - 평문 토큰은 발급 시 호출자에게 딱 한 번만 반환한다. DB·로그·에러메시지·
 *   목록 조회 어디에도 평문(또는 전체 해시)을 남기지 않는다.
 * - 토큰은 256비트 이상의 암호학적 난수로 만든다(node:crypto randomBytes).
 * - 검증 실패는 이유를 세분화해 노출하지 않는다 — 항상 null.
 */
import { createHash, randomBytes } from "node:crypto";
import { assertValidTeamId } from "./config.ts";
import { isoNow } from "./dates.ts";
import { getTeam, type Db } from "./db.ts";

/** 토큰 엔트로피. 32바이트 = 256비트. base64url 인코딩이라 URL/헤더에 안전하다. */
const TOKEN_BYTES = 32;
/** 목록 조회에서 사람이 알아볼 수 있게 보여줄 해시 접두 길이. 전체 해시는 노출하지 않는다. */
const HASH_PREFIX_LEN = 12;

function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** 평문 토큰 → 저장용 SHA-256 해시(hex). 이 함수 밖으로 평문이 나가지 않게 한다. */
function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface IssuedTeamToken {
  /** 평문 토큰. 이 반환값이 유일한 노출 지점이다 — 호출자가 안전한 채널로 전달해야 한다. */
  token: string;
  teamId: string;
}

/**
 * 팀 토큰을 새로 발급한다.
 * 팀이 존재하지 않으면(getTeam 이 null) 거부한다 — 존재하지 않는 팀으로 발급을 시도하는
 * 것 자체가 설정 오류이므로 여기서 막는다.
 */
export async function issueTeamToken(
  db: Db,
  teamId: string,
  label?: string,
): Promise<IssuedTeamToken> {
  assertValidTeamId(teamId);
  const team = await getTeam(db, teamId);
  if (!team) {
    throw new Error(`토큰을 발급할 팀이 존재하지 않습니다: ${teamId}`);
  }

  const token = generateToken();
  const tokenHash = hashToken(token);

  await db.run(
    `INSERT INTO team_tokens (token_hash, team_id, label, created_at, last_used_at, revoked)
     VALUES (?,?,?,?,NULL,0)`,
    [tokenHash, teamId, label ?? "", isoNow()],
  );

  return { token, teamId };
}

export interface VerifiedTeamToken {
  teamId: string;
}

/**
 * 토큰을 검증한다.
 * 없음 / 형식이 다름 / 해지됨 — 이유를 구분하지 않고 전부 null 로 돌려준다.
 * 성공하면 last_used_at 을 갱신한다.
 */
export async function verifyTeamToken(db: Db, token: string): Promise<VerifiedTeamToken | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);

  const row = (await db.get(
    "SELECT team_id, revoked FROM team_tokens WHERE token_hash = ?",
    [tokenHash],
  )) as { team_id: string; revoked: number } | undefined;

  if (!row || row.revoked) return null;

  await db.run("UPDATE team_tokens SET last_used_at = ? WHERE token_hash = ?", [isoNow(), tokenHash]);

  return { teamId: row.team_id };
}

/** 토큰을 해지한다(삭제하지 않고 revoked 플래그만 세운다). 존재하지 않아도 조용히 반환한다. */
export async function revokeTeamToken(db: Db, token: string): Promise<void> {
  if (!token) return;
  const tokenHash = hashToken(token);
  await db.run("UPDATE team_tokens SET revoked = 1 WHERE token_hash = ?", [tokenHash]);
}

export interface TeamTokenMeta {
  /** 전체 해시가 아니라 앞부분만 — 사람이 어떤 토큰인지 구분하는 용도. 재구성해 검증에 쓸 수 없다. */
  tokenHashPrefix: string;
  teamId: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

/** 팀 토큰 메타 목록. 평문·전체 해시는 절대 포함하지 않는다. */
export async function listTeamTokens(db: Db, teamId?: string): Promise<TeamTokenMeta[]> {
  const rows = (
    teamId
      ? await db.all(
          `SELECT token_hash, team_id, label, created_at, last_used_at, revoked
           FROM team_tokens WHERE team_id = ? ORDER BY created_at DESC`,
          [teamId],
        )
      : await db.all(
          `SELECT token_hash, team_id, label, created_at, last_used_at, revoked
           FROM team_tokens ORDER BY created_at DESC`,
        )
  ) as Array<{
    token_hash: string;
    team_id: string;
    label: string;
    created_at: string;
    last_used_at: string | null;
    revoked: number;
  }>;

  return rows.map((row) => ({
    tokenHashPrefix: row.token_hash.slice(0, HASH_PREFIX_LEN),
    teamId: row.team_id,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revoked: Boolean(row.revoked),
  }));
}
