/**
 * 세션 파일 상태 조회.
 *
 * 브라우저를 띄우지 않고 파일만 본다. 화면에서 "지금 로그인 상태인가"를
 * 즉시 보여주기 위한 용도라 가벼워야 한다.
 *
 * 실측: access.broadcom.com 의 sspsession 쿠키가 SSO 세션의 수명을 쥐고 있고
 * 약 12시간이다. 반면 _iat1 / __Secure-ob-* 는 1년짜리 기기 신뢰 표식이라
 * 이게 살아 있으면 재로그인 때 OTP를 다시 묻지 않는다.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_TEAM_ID, sessionFileForTeam } from "./config.ts";
// 쿠키 이름은 browserIdentity 가 정본이다. 로그인 경로와 같은 판정을 써야 한다.
import { SSO_SESSION_COOKIE, isDeviceTrustCookie } from "./browserIdentity.ts";

export interface SessionStatus {
  exists: boolean;
  /** 만료 시각(ms). 알 수 없으면 null */
  expiresAt: number | null;
  expired: boolean;
  /** 기기 신뢰 표식이 남아 있는가 (있으면 재로그인 시 OTP 생략 가능) */
  deviceTrusted: boolean;
}

interface StoredCookie {
  name: string;
  domain: string;
  expires?: number;
}

/** 읽을 수 없는 세션은 만료로 본다 — 쓸 수 없다는 점에서 같다. */
const UNUSABLE: SessionStatus = { exists: true, expiresAt: null, expired: true, deviceTrusted: false };

/**
 * 세션 JSON 문자열의 상태를 판정한다.
 *
 * 파일이 아니라 문자열을 받는다 — DB 백업 블롭(team_session_state.session_json)도
 * 같은 규칙으로 재 봐야 하기 때문이다. 파일 mtime 을 보지 않으므로 수집기 VM 과
 * 웹의 시계가 어긋나도 판정이 흔들리지 않는다.
 */
export function sessionStatusFromJson(json: string): SessionStatus {
  let cookies: StoredCookie[] = [];
  try {
    const parsed = JSON.parse(json) as { cookies?: StoredCookie[] };
    // 이름이 문자열인 것만 남긴다. DB 백업 블롭은 어떤 모양으로든 올 수 있고, 여기서
    // 터지면 쓰기 라우트가 hydrate 단계에서 500 으로 죽는다(세션 안내조차 못 한다).
    cookies = (parsed.cookies ?? []).filter(
      (c): c is StoredCookie => typeof (c as StoredCookie | undefined)?.name === "string",
    );
  } catch {
    return UNUSABLE;
  }

  const now = Date.now();

  const sso = cookies.find((c) => c.name === SSO_SESSION_COOKIE);
  // Playwright 는 만료를 초 단위로 저장한다. 음수면 세션 쿠키.
  const expiresAt =
    sso?.expires !== undefined && sso.expires > 0 ? Math.round(sso.expires * 1000) : null;

  const deviceTrusted = cookies.some(
    (c) =>
      isDeviceTrustCookie(c.name) &&
      (c.expires === undefined || c.expires <= 0 || c.expires * 1000 > now),
  );

  return {
    exists: true,
    expiresAt,
    expired: expiresAt === null ? true : expiresAt <= now,
    deviceTrusted,
  };
}

/** teamId 를 생략하면 기본 팀의 세션 파일(기존 SESSION_FILE)을 본다. */
export function getSessionStatus(teamId: string = DEFAULT_TEAM_ID): SessionStatus {
  const path = resolve(sessionFileForTeam(teamId));
  if (!existsSync(path)) {
    return { exists: false, expiresAt: null, expired: true, deviceTrusted: false };
  }
  try {
    return sessionStatusFromJson(readFileSync(path, "utf8"));
  } catch {
    return UNUSABLE;
  }
}
