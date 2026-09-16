/**
 * MCP 서버 인증.
 *
 * 매 연결/요청마다 Authorization 헤더의 팀 토큰을 검증해 teamId 를 확정한다.
 * lib/teamToken.ts(verifyTeamToken)를 그대로 재사용한다 — 여긴 HTTP 경계
 * (헤더 파싱·길이 상한·에러 모양)만 담당한다.
 *
 * 보안 원칙(Step 3 리뷰 캐리):
 * - 토큰 길이 상한을 verifyTeamToken 호출 **전에** 검사한다. 과대 입력을
 *   해시(sha256)까지 흘려보내는 것 자체가 값싼 DoS 표면이라, 여기서 먼저 끊는다.
 * - 실패 이유는 세분화해 노출하지 않는다(teamToken.ts 와 동일한 원칙) — 항상
 *   같은 모양의 401 을 돌려준다.
 */
import type { DatabaseSync } from "node:sqlite";
import { verifyTeamToken } from "../lib/teamToken.ts";

/**
 * 이 값을 넘는 토큰은 해시 계산 없이 즉시 거부한다.
 * 발급 토큰은 32바이트를 base64url 로 인코딩한 43자 안팎이라 512자면 넉넉한 상한이다.
 */
export const MAX_TOKEN_LENGTH = 512;

export type HeaderValue = string | readonly string[] | undefined | null;

/** "Bearer <token>" 형식에서 토큰만 뽑는다. 형식이 다르면 null. */
export function extractBearerToken(headerValue: HeaderValue): string | null {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof raw !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  if (!match) return null;
  const token = match[1]!.trim();
  return token === "" ? null : token;
}

export interface AuthSuccess {
  ok: true;
  teamId: string;
}

export interface AuthFailure {
  ok: false;
  status: 401;
  message: string;
}

export type AuthResult = AuthSuccess | AuthFailure;

const GENERIC_FAILURE_MESSAGE = "인증 토큰이 없거나 유효하지 않습니다.";

function fail(): AuthFailure {
  return { ok: false, status: 401, message: GENERIC_FAILURE_MESSAGE };
}

/**
 * verify 를 기본값(verifyTeamToken)이 아닌 다른 함수로 주입할 수 있게 한 이유는
 * 오직 테스트 때문이다 — "너무 긴 토큰은 verify 를 아예 부르지 않는다"를
 * 스파이로 직접 확인하기 위해서다. 실제 서버(mcp/server.ts)는 기본값을 그대로 쓴다.
 */
export function authenticateToken(
  db: DatabaseSync,
  rawHeader: HeaderValue,
  verify: (db: DatabaseSync, token: string) => { teamId: string } | null = verifyTeamToken,
): AuthResult {
  const token = extractBearerToken(rawHeader);
  if (token === null) return fail();
  if (token.length > MAX_TOKEN_LENGTH) return fail();

  const verified = verify(db, token);
  if (verified === null) return fail();

  return { ok: true, teamId: verified.teamId };
}
