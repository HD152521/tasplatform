"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { COLOR, MONO_STACK, RADIUS, formatStamp } from "./ui.tsx";

interface Counts {
  open: number;
  closed: number;
  unread: number;
  cves: number;
  criticalCves: number;
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

  const items = [
    { href: "/", label: "진행중", count: counts.open, badge: counts.unread },
    { href: "/closed", label: "종료", count: counts.closed, badge: 0 },
    { href: "/new", label: "SR 작성", count: null, badge: 0 },
    { href: "/cves", label: "보안 공지", count: counts.cves, badge: counts.criticalCves },
    { href: "/logs", label: "수집 로그", count: null, badge: 0 },
  ];

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
          const active = item.href === "/" ? path === "/" : path.startsWith(item.href);
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
        <div style={{
          display: "flex", alignItems: "center", gap: 8, fontSize: 12,
          color: signedIn ? COLOR.ok : COLOR.waitUs,
        }}>
          <span style={{
            width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
            background: signedIn ? COLOR.ok : COLOR.waitUs,
          }} />
          <span>{signedIn ? "세션 연결됨" : "세션 없음"}</span>
        </div>
        <div style={{ fontSize: 11, color: COLOR.faint, marginTop: 5, paddingLeft: 15, lineHeight: 1.6 }}>
          {signedIn && expiresAt !== null
            ? `${formatStamp(expiresAt)}까지`
            : "로그인이 필요합니다"}
        </div>
        <div style={{ marginTop: 9, paddingLeft: 15 }}>{authSlot}</div>
      </div>
    </aside>
  );
}
