/**
 * 헬스체크 상태 구성(순수 로직).
 *
 * app/api/health/route.ts 가 DB 를 열고 조회한 뒤, 그 결과로 응답 본문을 만들 때 쓰는
 * 순수 함수들이다. fetch·DB·시각 획득 같은 부작용은 라우트가 담당하고, 여기서는 값만 조립한다
 * (테스트 가능하도록 분리).
 *
 * 보안: 응답에 접속문자열·비밀번호·호스트·계정명·스키마 상세를 절대 담지 않는다. 성공 시엔
 * 방언(postgres/sqlite)과 팀 수 정도만, 실패 시엔 원문 대신 고정된 요약 코드만 노출한다.
 */
import type { Dialect } from "./dbConn.ts";

export interface HealthOk {
  readonly ok: true;
  readonly dialect: Dialect;
  readonly teams: number;
  readonly at: string;
}

export interface HealthError {
  readonly ok: false;
  readonly error: string;
}

export type HealthStatus = HealthOk | HealthError;

/** DB 조회가 성공했을 때의 응답 본문을 만든다. */
export function healthOk(dialect: Dialect, teams: number, at: string): HealthOk {
  return { ok: true, dialect, teams, at };
}

/**
 * DB 오류를 고정된 요약 코드로만 분류한다(원문 미노출).
 *
 * pg/네트워크 에러 원문에는 호스트·계정·스키마가 섞일 수 있어 그대로 응답에 실으면 정보가 샌다.
 * 그래서 메시지를 소문자로 훑어 아래 고정 코드 중 하나로만 환원한다 — 반환값은 항상 이 목록에
 * 든 상수라 어떤 입력에도 자격/호스트가 새지 않는다. 디버깅용 원문은 라우트가 서버 로그에만 남긴다.
 */
export function summarizeHealthError(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes("timeout") || message.includes("etimedout")) return "db_timeout";
  if (
    message.includes("enotfound") ||
    message.includes("econnrefused") ||
    message.includes("connect")
  ) {
    return "db_unreachable";
  }
  if (message.includes("password") || message.includes("authentication")) return "db_auth_failed";
  return "db_error";
}

/** DB 조회가 실패했을 때의 응답 본문을 만든다(요약 코드만). */
export function healthError(error: unknown): HealthError {
  return { ok: false, error: summarizeHealthError(error) };
}
