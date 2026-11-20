import type { ReactNode } from "react";
import { currentUser } from "../lib/appAuth.ts";
import { DEFAULT_TEAM_ID } from "../lib/config.ts";
import { getSessionStatus } from "../lib/sessionFile.ts";
import { hydrateTeamSessionFromDb } from "../lib/sessionStore.ts";
import { countsForNav } from "../lib/queries.ts";
import { AuthNav } from "./AuthNav.tsx";
import { SideNav } from "./SideNav.tsx";
import { COLOR, FONT_STACK } from "./ui.tsx";

export const metadata = {
  title: "Broadcom SR Hub",
  description: "Broadcom 서비스 요청 수집 및 열람",
};

export const dynamic = "force-dynamic";

const EMPTY_COUNTS = { open: 0, closed: 0, unread: 0, cves: 0, criticalCves: 0, kb: 0, kbMatch: 0 };

/**
 * 공통 껍데기.
 *
 * ## 로그인하지 않았으면 네비게이션을 그리지 않는다
 *
 * 문(인증)은 페이지마다 `requireUser()` 가 지킨다(lib/appAuth.ts 머리말 — 왜 미들웨어가
 * 아닌지도 거기 있다). 여기서는 **껍데기만** 가른다: 로그인 전에는 사이드바를 띄우지
 * 않는다. 누르면 전부 로그인 화면으로 되돌아오는 메뉴를 보여 줄 이유가 없다.
 *
 * 로그인 전에는 포털 세션 복원과 건수 집계도 **건너뛴다.** 로그인 화면 한 장을 그리려고
 * DB 를 세 번 읽을 필요가 없다.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const appUser = await currentUser();

  let counts = EMPTY_COUNTS;
  let portalSignedIn = false;
  let expiresAt: number | null = null;

  if (appUser !== null) {
    // 재시작으로 세션 파일이 없으면 DB 백업에서 복원한다(파일이 있으면 즉시 반환 — 저렴).
    try {
      await hydrateTeamSessionFromDb(DEFAULT_TEAM_ID);
    } catch {
      // 세션 복원 실패가 화면 렌더를 막지 않는다.
    }
    const session = getSessionStatus();
    portalSignedIn = session.exists && !session.expired;
    expiresAt = session.expiresAt;

    // DB가 아직 없어도 화면은 떠야 하므로 실패하면 0으로 둔다.
    try {
      counts = await countsForNav();
    } catch {
      counts = EMPTY_COUNTS;
    }
  }

  return (
    <html lang="ko">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&display=swap"
        />
      </head>
      <body style={{
        margin: 0,
        fontFamily: FONT_STACK,
        color: COLOR.ink,
        background: COLOR.ground,
        WebkitFontSmoothing: "antialiased",
      }}>
        {appUser === null ? (
          <main style={{ padding: "0 20px 60px" }}>{children}</main>
        ) : (
          <div style={{ display: "flex", minHeight: "100vh" }}>
            <SideNav
              counts={counts}
              signedIn={portalSignedIn}
              expiresAt={expiresAt}
              authSlot={<AuthNav signedIn={portalSignedIn} />}
              user={{
                displayName: appUser.displayName,
                loginId: appUser.loginId,
                teamName: appUser.teamName,
                role: appUser.role,
              }}
            />

            <main style={{ flex: 1, minWidth: 0, padding: "26px 32px 60px" }}>
              <div style={{ maxWidth: 1180, margin: "0 auto" }}>{children}</div>
            </main>
          </div>
        )}
      </body>
    </html>
  );
}
