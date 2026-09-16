/**
 * 브라우저 신원 — IdP 에게 "같은 기기"로 보이기 위한 것들.
 *
 * 로그인 경로들이 빈 컨텍스트로 시작하는 바람에 기기 신뢰 쿠키가 저장만 되고
 * 다시 쓰이지 않았다. 그래서 매 로그인마다 IdP 가 처음 보는 기기로 판단해
 * 이메일 OTP 를 요구했다. 여기서 그 쿠키만 골라 넘겨준다.
 *
 * 세션 쿠키(sspsession)는 반드시 제외한다. 만료된 채로 넘기면 로그인 위젯이
 * 조용한 재인증을 시도하다 "Authenticating the user" 에서 무한 대기한다(실측).
 *
 * UA 도 함께 고정한다. headed 로그인과 headless 수집의 UA 가 다르면
 * (headless 는 UA 에 HeadlessChrome 이 붙는다) 기기 신뢰가 지문에 묶여 있을 때
 * 쿠키를 넘겨도 다른 기기로 판정될 수 있다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Browser, BrowserContextOptions } from "playwright";
import { DEFAULT_TEAM_ID, DEVICE_FILE, deviceFileForTeam } from "./config.ts";

/** SSO 세션 수명을 쥔 쿠키. 기기 신뢰와 분리해야 한다. */
export const SSO_SESSION_COOKIE = "sspsession";

/**
 * 기기 신뢰 표식(1년짜리). 이게 살아 있으면 재로그인 때 OTP 를 묻지 않는다.
 *
 * `__Secure-ssp-username` 과 `__Secure-rbu` 는 일부러 뺐다. 사용자를 기억시키는
 * 쪽이라 위젯이 아이디 입력을 건너뛸 수 있고, 그러면 `performCredentialLogin` 의
 * 아이디 단계와 어긋난다. 신뢰 판정에는 아래 둘로 충분하다.
 */
export const DEVICE_TRUST_COOKIE_PREFIXES = ["_iat1", "__Secure-ob-"] as const;

/**
 * 기기 신뢰는 쿠키만이 아니다. IdP 는 localStorage 에도 기기 표식을 남긴다.
 *   default.ssp-ah_dfp  기기 지문(device fingerprint)
 *   _ia01 / _ia01_timestamp_   _iat1 쿠키와 짝을 이루는 기기 식별자
 * 쿠키만 넣고 이걸 빠뜨리면 IdP 가 다른 기기로 보고 MFA 를 요구한다.
 */
export const DEVICE_TRUST_ORIGIN = "https://access.broadcom.com";
export const DEVICE_TRUST_STORAGE_KEYS = ["_ia01", "default.ssp-ah_dfp"] as const;

export const VIEWPORT = { width: 1600, height: 950 } as const;

export interface StoredCookie {
  name: string;
  domain: string;
  expires?: number;
  [key: string]: unknown;
}

export interface StoredOrigin {
  origin: string;
  localStorage?: Array<{ name: string; value: string }>;
}

export interface StorageState {
  cookies?: StoredCookie[];
  origins?: StoredOrigin[];
}

export function isDeviceTrustCookie(name: string): boolean {
  return DEVICE_TRUST_COOKIE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Playwright 는 만료를 초 단위로 저장한다. 음수/미지정이면 세션 쿠키로 본다. */
function isAlive(cookie: StoredCookie, now: number): boolean {
  if (cookie.expires === undefined || cookie.expires <= 0) return true;
  return cookie.expires * 1000 > now;
}

/** 살아 있는 기기 신뢰 쿠키만 골라낸다. */
export function extractDeviceCookies(state: StorageState, now = Date.now()): StoredCookie[] {
  return (state.cookies ?? []).filter((c) => isDeviceTrustCookie(c.name) && isAlive(c, now));
}

/** IdP 가 localStorage 에 남긴 기기 표식만 골라낸다. */
export function extractDeviceOrigins(state: StorageState): StoredOrigin[] {
  const origin = (state.origins ?? []).find((o) => o.origin === DEVICE_TRUST_ORIGIN);
  if (origin === undefined) return [];

  const localStorage = (origin.localStorage ?? []).filter((item) =>
    DEVICE_TRUST_STORAGE_KEYS.some((key) => item.name.startsWith(key)),
  );
  return localStorage.length === 0 ? [] : [{ origin: DEVICE_TRUST_ORIGIN, localStorage }];
}

/**
 * 기기 신뢰 표식(쿠키 + localStorage)만 담은 상태 파일을 남긴다.
 * 골라낸 게 하나도 없으면 쓰지 않는다 — 멀쩡한 기존 파일을 비우지 않기 위해서다.
 */
export function saveDeviceState(state: StorageState, file: string = DEVICE_FILE): boolean {
  const cookies = extractDeviceCookies(state);
  const origins = extractDeviceOrigins(state);
  if (cookies.length === 0 && origins.length === 0) return false;

  const path = resolve(file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ cookies, origins }), "utf8");
  return true;
}

/** 로그인 컨텍스트에 넘길 상태 파일 경로. 없으면 undefined (빈 컨텍스트). */
export function deviceStatePath(file: string = DEVICE_FILE): string | undefined {
  const path = resolve(file);
  return existsSync(path) ? path : undefined;
}

/** 기기 신뢰가 실제로 쓸 수 있는 상태인지. 로그에 쓴다. */
export function deviceTrustAvailable(file: string = DEVICE_FILE): boolean {
  const path = deviceStatePath(file);
  if (path === undefined) return false;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as StorageState;
    return extractDeviceCookies(state).length > 0 || extractDeviceOrigins(state).length > 0;
  } catch {
    return false;
  }
}

/**
 * 실제 Chrome 과 같은 모양의 UA. 번들된 Chromium 버전에 맞춰 만든다.
 * 상수로 박아두면 Playwright 업데이트 후 엔진과 어긋난다.
 */
export function chromeUserAgent(browser: Browser): string {
  const major = browser.version().split(".")[0] || "140";
  return (
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
    `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
  );
}

/**
 * 로그인용 컨텍스트 옵션. 기기 신뢰를 넘겨 OTP 를 건너뛴다.
 * teamId 를 생략하면 기본 팀(DEFAULT_TEAM_ID) 의 기기 신뢰 파일을 쓴다 —
 * 이는 곧 기존 DEVICE_FILE 경로와 동일하다.
 */
export function loginContextOptions(
  browser: Browser,
  teamId: string = DEFAULT_TEAM_ID,
): BrowserContextOptions {
  return {
    viewport: VIEWPORT,
    userAgent: chromeUserAgent(browser),
    storageState: deviceStatePath(deviceFileForTeam(teamId)),
  };
}

/** 수집용 컨텍스트 옵션. 저장된 세션으로 연다. */
export function sessionContextOptions(browser: Browser, sessionFile: string): BrowserContextOptions {
  return {
    viewport: VIEWPORT,
    userAgent: chromeUserAgent(browser),
    storageState: sessionFile,
  };
}
