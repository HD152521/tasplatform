/**
 * 화면·API 가 "지금 누가 쓰고 있나" 를 묻는 한 곳.
 *
 * ## 왜 미들웨어가 아닌가
 *
 * `middleware.ts` 로 한 번에 막는 쪽이 짧아 보이지만 두 가지가 걸린다.
 *
 *   1. 세션 검증이 **DB 조회**다. Next 미들웨어는 기본이 edge 런타임이라 `node:sqlite`
 *      도 `pg` 도 못 쓴다. 쿠키가 "있는지" 만 보면 edge 에서도 되지만, 그러면 만료·해지된
 *      쿠키를 들고 들어온 사람이 신원 없이 화면을 보게 된다.
 *   2. 미들웨어는 `/api/*` 도 지나간다. 이 레포의 API 일부는 **수집기 VM 과 worker 가
 *      부른다**(자동 게시 깨우기 등). 거기에 사람 로그인을 요구하면 수집이 멈춘다.
 *
 * 그래서 문을 **페이지마다** 둔다. 이 앱의 모든 페이지는 이미 `force-dynamic` 이고
 * 서버에서 돌기 때문에, 페이지 첫 줄에 `requireUser()` 한 줄이면 끝난다. 명시적이고,
 * 리다이렉트 고리에 빠질 길이 없다(로그인 화면만 이 함수를 부르지 않는다).
 *
 * ## 쿠키
 *
 * `httpOnly` — 화면 스크립트가 토큰을 읽을 이유가 없다.
 * `sameSite=lax` — 다른 사이트에서 폼을 던져 우리 API 를 쓰는 것을 막되, 링크로
 *   들어오는 평범한 이동은 그대로 둔다.
 * `secure` — **요청이 https 였을 때만** 켠다. 사내망 http 로 접속하는 경우에
 *   무조건 켜면 브라우저가 쿠키를 아예 저장하지 않아 **로그인이 끝나지 않는다.**
 */
import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import {
  APP_SESSION_COOKIE,
  resolveUserSession,
  revokeUserSession,
} from "./appSession.ts";
import { openDb } from "./db.ts";
import type { UserWithTeam } from "./users.ts";

export type { UserWithTeam } from "./users.ts";

/** 로그인하지 않았을 때 보낼 곳. */
export const SIGNIN_PATH = "/signin";

/**
 * 지금 로그인한 사람. 없으면 null.
 *
 * `cache()` 로 감싼다 — 한 요청에서 레이아웃과 페이지가 각각 부르므로, 안 감싸면
 * 요청 하나에 DB 를 두 번 연다.
 */
export const currentUser = cache(async (): Promise<UserWithTeam | null> => {
  const jar = await cookies();
  const token = jar.get(APP_SESSION_COOKIE)?.value;
  if (!token) return null;

  const db = await openDb();
  try {
    return await resolveUserSession(db, token);
  } catch {
    // DB 가 아직 없거나 깨져 있어도 화면이 500 으로 죽지 않게 한다.
    // "모른다" 와 "로그인 안 했다" 를 같게 취급한다 — 어느 쪽이든 로그인 화면이다.
    return null;
  } finally {
    await db.close();
  }
});

/**
 * 페이지 전용 문. 로그인하지 않았으면 로그인 화면으로 보낸다.
 *
 * `next` 파라미터에 원래 가려던 곳을 담아 로그인 뒤 되돌려 준다.
 */
export async function requireUser(returnTo?: string): Promise<UserWithTeam> {
  const user = await currentUser();
  if (user !== null) return user;
  const suffix = returnTo ? `?next=${encodeURIComponent(returnTo)}` : "";
  redirect(`${SIGNIN_PATH}${suffix}`);
}

/**
 * 팀에 소속된 사람만. 가입은 됐지만 팀 연결이 끊긴 사람은 팀 화면으로 보낸다.
 *
 * 팀 없이 캘린더·브로드컴 계정 화면을 열면 "어느 팀 데이터인가" 가 정해지지 않는다.
 */
export async function requireTeamUser(returnTo?: string): Promise<UserWithTeam> {
  const user = await requireUser(returnTo);
  if (user.teamId === "") redirect("/team?noteam=1");
  return user;
}

/** owner 만. 아니면 팀 화면으로 되돌린다. */
export async function requireOwner(returnTo?: string): Promise<UserWithTeam> {
  const user = await requireTeamUser(returnTo);
  if (user.role !== "owner") redirect("/team?forbidden=1");
  return user;
}

/* ------------------------------------------------------------------ *
 * API 라우트용
 *
 * 라우트는 리다이렉트하지 않는다 — 화면이 fetch 로 부르므로 **401 JSON** 이 맞다.
 * ------------------------------------------------------------------ */

/** 요청 헤더의 쿠키에서 세션 토큰을 꺼낸다. */
export function sessionTokenFromRequest(request: Request): string {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== APP_SESSION_COOKIE) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return "";
}

/** 로그인한 사람 또는 null. 라우트가 직접 401 을 만든다. */
export async function userFromRequest(request: Request): Promise<UserWithTeam | null> {
  const token = sessionTokenFromRequest(request);
  if (token === "") return null;
  const db = await openDb();
  try {
    return await resolveUserSession(db, token);
  } finally {
    await db.close();
  }
}

/** 이미 열린 DB 로 확인한다. 라우트가 DB 를 또 열지 않게. */
export async function userFromRequestWith(
  db: import("./dbCore.ts").Db,
  request: Request,
): Promise<UserWithTeam | null> {
  const token = sessionTokenFromRequest(request);
  if (token === "") return null;
  return resolveUserSession(db, token);
}

/** 라우트에서 로그아웃 처리. 쿠키 삭제는 응답 쪽(라우트)이 한다. */
export async function signOutRequest(request: Request): Promise<void> {
  const token = sessionTokenFromRequest(request);
  if (token === "") return;
  const db = await openDb();
  try {
    await revokeUserSession(db, token);
  } finally {
    await db.close();
  }
}

/**
 * 감사 로그의 `actor` 로 쓸 문자열.
 *
 * 지금까지 이 칸은 **화면이 보내는 값**이었고 아무도 채우지 않아 늘 비어 있었다.
 * 앞으로는 서버가 세션에서 채운다 — 보내 온 값은 믿지 않는다.
 */
export function actorOf(user: UserWithTeam | null): string {
  if (user === null) return "";
  return user.displayName === "" ? user.loginId : `${user.displayName}(${user.loginId})`;
}
