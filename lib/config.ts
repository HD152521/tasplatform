/** 포털/수집 설정. 환경변수로 덮어쓸 수 있다. */
import { loadEnv } from "./env.ts";

/**
 * 여기서 직접 .env 를 읽는다.
 *
 * ESM 의 import 는 호이스팅되므로, 진입점이 `loadEnv()` 를 부르는 것만으로는
 * 늦다 — 그 호출보다 이 모듈의 평가가 먼저 끝나 아래 상수들이 .env 를 못 본다.
 * 실제로 CREDENTIALS 가 항상 null 이었다. 상수 선언보다 앞에서 불러야 한다.
 */
loadEnv();

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
/**
 * 기기 신뢰 쿠키만 담아 두는 파일. 로그인 시작 컨텍스트에 넘겨 OTP 를 건너뛴다.
 * 세션 파일과 분리한 이유는 lib/browserIdentity.ts 주석 참고.
 */
export const DEVICE_FILE = process.env.SR_DEVICE_FILE ?? "data/device.json";
export const DB_FILE = process.env.SR_DB_FILE ?? "data/sr.db";
export const LOCK_FILE = process.env.SR_LOCK_FILE ?? "data/collector.lock";

/**
 * 기본 팀. 팀 멀티테넌트로 넘어가기 전, 지금 단일 공용 계정을 담는 팀.
 * 기존 케이스·수집은 전부 이 팀에 귀속된다. 팀이 늘면 팀별 키가 붙는다.
 */
export const DEFAULT_TEAM_ID = process.env.SR_DEFAULT_TEAM ?? "default";

/**
 * 팀 id 형식. 영숫자·하이픈·언더스코어만 허용한다.
 *
 * sessionFileForTeam/deviceFileForTeam 이 teamId 를 `data/teams/<teamId>/...` 로
 * 그대로 보간하므로, `/`·`\`·`..` 등을 허용하면 resolve() 가 경로를 정규화하면서
 * data/teams/ 밖으로 탈출할 수 있다(경로 탈출). Step 4(MCP)부터 teamId 가 외부
 * 입력이 되므로 그 전에 이 두 함수 진입부에서 반드시 막는다.
 */
const TEAM_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function assertValidTeamId(teamId: string): void {
  if (!TEAM_ID_PATTERN.test(teamId)) {
    throw new Error(
      `잘못된 팀 id 입니다: ${JSON.stringify(teamId)} (영숫자·하이픈(-)·언더스코어(_)만 허용)`,
    );
  }
}

/**
 * 팀별 세션/기기신뢰 파일 경로.
 *
 * 기본 팀은 반드시 기존 파일(SESSION_FILE/DEVICE_FILE)을 그대로 쓴다 — 실사용 중인
 * 수집기·로그인 흐름이 파일 위치가 바뀌는 것만으로 깨지면 안 된다. 다른 팀만
 * `data/teams/<teamId>/` 아래 별도 경로를 쓴다.
 */
export function sessionFileForTeam(teamId: string = DEFAULT_TEAM_ID): string {
  assertValidTeamId(teamId);
  return teamId === DEFAULT_TEAM_ID ? SESSION_FILE : `data/teams/${teamId}/session.json`;
}

export function deviceFileForTeam(teamId: string = DEFAULT_TEAM_ID): string {
  assertValidTeamId(teamId);
  return teamId === DEFAULT_TEAM_ID ? DEVICE_FILE : `data/teams/${teamId}/device.json`;
}

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
