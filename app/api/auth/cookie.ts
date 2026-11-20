/**
 * 앱 세션 쿠키를 응답에 붙이고 떼는 한 곳.
 *
 * `secure` 를 **요청 프로토콜에서 정한다.** 사내망은 http 로 접속하는 경우가 있고,
 * 그때 secure 를 켜면 브라우저가 쿠키를 저장하지 않아 로그인이 끝나지 않는다
 * (화면은 "성공" 이라 하고 다음 요청은 비로그인 — 원인을 찾기 가장 어려운 모양이다).
 *
 * TAS 같은 프록시 뒤에서는 요청 URL 이 http 로 보이므로 `x-forwarded-proto` 도 본다.
 */
import type { NextResponse } from "next/server";
import { APP_SESSION_COOKIE } from "../../../lib/appSession.ts";

function isHttps(request: Request): boolean {
  const forwarded = (request.headers.get("x-forwarded-proto") ?? "").split(",")[0]?.trim();
  if (forwarded !== undefined && forwarded !== "") return forwarded === "https";
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function setSessionCookie(
  response: NextResponse,
  request: Request,
  token: string,
  maxAgeSeconds: number,
): void {
  response.cookies.set({
    name: APP_SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: isHttps(request),
    path: "/",
    maxAge: maxAgeSeconds,
  });
}

export function clearSessionCookie(response: NextResponse, request: Request): void {
  response.cookies.set({
    name: APP_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: isHttps(request),
    path: "/",
    maxAge: 0,
  });
}
