import type { ReactNode } from "react";
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

export default async function RootLayout({ children }: { children: ReactNode }) {
  // 재시작으로 세션 파일이 없으면 DB 백업에서 복원한다(파일이 있으면 즉시 반환 — 저렴).
  try {
    await hydrateTeamSessionFromDb(DEFAULT_TEAM_ID);
  } catch {
    // 세션 복원 실패가 화면 렌더를 막지 않는다.
  }
  const session = getSessionStatus();
  const signedIn = session.exists && !session.expired;

  // DB가 아직 없어도 화면은 떠야 하므로 실패하면 0으로 둔다.
  let counts = { open: 0, closed: 0, unread: 0, cves: 0, criticalCves: 0, kb: 0, kbMatch: 0 };
  try {
    counts = await countsForNav();
  } catch {
    counts = { open: 0, closed: 0, unread: 0, cves: 0, criticalCves: 0, kb: 0, kbMatch: 0 };
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
        <div style={{ display: "flex", minHeight: "100vh" }}>
          <SideNav
            counts={counts}
            signedIn={signedIn}
            expiresAt={session.expiresAt}
            authSlot={<AuthNav signedIn={signedIn} />}
          />

          <main style={{ flex: 1, minWidth: 0, padding: "26px 32px 60px" }}>
            <div style={{ maxWidth: 1180, margin: "0 auto" }}>{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
