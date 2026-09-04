/** 포털/수집 설정. 환경변수로 덮어쓸 수 있다. */

export const PORTAL_ORIGIN = "https://broadcomcms-software.wolkenservicedesk.com";
export const API_ORIGIN = "https://api-broadcomcms-software.wolkenservicedesk.com";
export const PORTAL_HOME = PORTAL_ORIGIN + "/wolken-support/home";

/**
 * API 서버가 Origin 헤더를 검증한다. 이 헤더 없이 호출하면
 * 세션이 유효해도 401 "You do not have permission" 이 돌아온다 (실측 확인).
 */
export const API_HEADERS: Record<string, string> = {
  Origin: PORTAL_ORIGIN,
  Referer: PORTAL_ORIGIN + "/",
  Accept: "application/json, text/plain, */*",
};

export const SESSION_FILE = process.env.SR_SESSION_FILE ?? "data/session.json";
export const DB_FILE = process.env.SR_DB_FILE ?? "data/sr.db";
export const LOCK_FILE = process.env.SR_LOCK_FILE ?? "data/collector.lock";

/** 최초 수집 시 가져올 종료 케이스 범위 */
export const BACKFILL_MONTHS = numFromEnv("SR_BACKFILL_MONTHS", 3);
/** 백필 경계에서 페이지를 얼마나 더 훑고 멈출지 (안전 여유) */
export const SCAN_MARGIN_MONTHS = numFromEnv("SR_SCAN_MARGIN_MONTHS", 3);
export const PAGE_SIZE = numFromEnv("SR_PAGE_SIZE", 100);
export const REQUEST_DELAY_MS = numFromEnv("SR_REQUEST_DELAY_MS", 800);

/**
 * 자동 로그인 계정. .env 로만 주입하고 코드에 하드코딩하지 않는다.
 * 없으면 null 이고, 그 경우 수동 로그인만 가능하다.
 */
export interface Credentials {
  readonly username: string;
  readonly password: string;
}

function readCredentials(): Credentials | null {
  const username = process.env.SR_USERNAME?.trim();
  const password = process.env.SR_PASSWORD;
  if (!username || !password) return null;
  return { username, password };
}

export const CREDENTIALS: Credentials | null = readCredentials();

export const NAV_TIMEOUT_MS = 90_000;
/** 목록 조회 시 안전장치. 이보다 많이 넘기면 중단한다. */
export const MAX_PAGES = 50;

function numFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`환경변수 ${name} 값이 올바르지 않습니다: ${raw}`);
  }
  return parsed;
}
