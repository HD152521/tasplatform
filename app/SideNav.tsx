"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { activeNavHref } from "../lib/navActive.ts";
import { COLOR, MONO_STACK, RADIUS } from "./ui.tsx";
import { SessionDot } from "./SessionDot.tsx";

interface Counts {
  open: number;
  closed: number;
  unread: number;
  cves: number;
  criticalCves: number;
  kb: number;
  kbMatch: number;
}

/**
 * 좌측 네비게이션.
 *
 * 상단 가로 메뉴 대신 세로로 둔 이유는 각 항목의 건수를 항상 보이게 하기 위해서다.
 * "어디에 몇 건이 있고, 그중 몇 건이 내 확인을 기다리는가"가 이 도구의 첫 질문이다.
 */
export function SideNav({
  counts, signedIn, expiresAt, authSlot,
}: {
  counts: Counts;
  signedIn: boolean;
  expiresAt: number | null;
  authSlot: ReactNode;
}) {
  const path = usePathname();

  const items: Array<{ href: string; label: string; count: number | null; badge: number }> = [
    { href: "/", label: "진행중", count: counts.open, badge: counts.unread },
    { href: "/closed", label: "종료", count: counts.closed, badge: 0 },
    { href: "/new", label: "SR 작성", count: null, badge: 0 },
    { href: "/cves", label: "보안 공지", count: counts.cves, badge: counts.criticalCves },
    { href: "/kb", label: "기술 문서", count: counts.kb, badge: counts.kbMatch },
    { href: "/report", label: "정기점검", count: null, badge: 0 },
    { href: "/logs", label: "수집 로그", count: null, badge: 0 },
    // "연동 설정" 은 걷어냈다 — 아무 일도 하지 않는 화면이었다(app/settings/page.tsx).
    // `/settings` 는 여기로 리다이렉트된다.
    { href: "/settings/llm", label: "LLM 연결", count: null, badge: 0 },
  ];

  // 지금 어느 항목에 있나. **가장 깊게 맞는 것 하나만** 켠다.
  //
  // 전에는 `path.startsWith(item.href)` 였다. 그러면 `/settings/llm` 에서 `/settings`
  // 도 걸려 **두 항목이 같이 켜져 보였다** — 어디에 있는지 알 수 없다.
  // 이 규칙은 lib/navActive.ts 에 두고 단위 시험으로 잠근다.
  const activeHref = activeNavHref(path, items.map((i) => i.href));

  return (
    <aside style={{
      width: 268, flexShrink: 0, background: COLOR.surface,
      borderRight: `1px solid ${COLOR.line}`,
      display: "flex", flexDirection: "column",
      position: "sticky", top: 0, height: "100vh",
    }}>
      <div style={{ padding: "22px 20px 18px", borderBottom: `1px solid ${COLOR.divider}` }}>
        <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.01em" }}>Broadcom SR</div>
        <div style={{ fontSize: 12, color: COLOR.muted, marginTop: 2 }}>데이터솔루션 지원팀</div>
      </div>

      <nav style={{ padding: "14px 12px", display: "flex", flexDirection: "column", gap: 2 }}>
        {items.map((item) => {
          const active = item.href === activeHref;
          return (
            <Link key={item.href} href={item.href} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "9px 12px", borderRadius: 8, fontSize: 13, textDecoration: "none",
              fontWeight: active ? 600 : 400,
              color: active ? COLOR.ink : "#4b5563",
              background: active ? "#eef1f6" : "transparent",
            }}>
              <span style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <span style={{
                  width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                  background: active ? COLOR.accent : "#c7ccd4",
                }} />
                {item.label}
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {item.badge > 0 && (
                  <span style={{
                    fontFamily: MONO_STACK, fontSize: 11, fontWeight: 600, color: "#ffffff",
                    background: COLOR.waitUs, padding: "1px 6px", borderRadius: RADIUS.badge,
                  }}>
                    {item.badge}
                  </span>
                )}
                {item.count !== null && (
                  <span style={{
                    fontFamily: MONO_STACK, fontVariantNumeric: "tabular-nums",
                    fontSize: 12, color: COLOR.faint,
                  }}>
                    {item.count}
                  </span>
                )}
              </span>
            </Link>
          );
        })}
      </nav>

      <div style={{ marginTop: "auto", padding: "16px 20px", borderTop: `1px solid ${COLOR.divider}` }}>
        {/*
          밑줄까지 SessionDot 이 그린다. 표시등은 포털에 물어 고쳐 그리는데 밑줄은
          쿠키 기준으로 남으면, 세션이 죽은 상태에서 "…까지" 가 같이 보여 엇갈린다.
        */}
        <SessionDot signedIn={signedIn} expiresAt={expiresAt} />
        <div style={{ marginTop: 9, paddingLeft: 15 }}>{authSlot}</div>
      </div>
    </aside>
  );
}
