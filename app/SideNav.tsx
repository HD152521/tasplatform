"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useState } from "react";
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

/** 지금 이 화면을 보는 사람. 레이아웃이 세션에서 읽어 넘긴다. */
interface UserChip {
  displayName: string;
  loginId: string;
  teamName: string;
  role: "owner" | "member";
}

/**
 * 좌측 네비게이션.
 *
 * 상단 가로 메뉴 대신 세로로 둔 이유는 각 항목의 건수를 항상 보이게 하기 위해서다.
 * "어디에 몇 건이 있고, 그중 몇 건이 내 확인을 기다리는가"가 이 도구의 첫 질문이다.
 */
export function SideNav({
  counts, signedIn, expiresAt, authSlot, user,
}: {
  counts: Counts;
  signedIn: boolean;
  expiresAt: number | null;
  authSlot: ReactNode;
  user: UserChip;
}) {
  const path = usePathname();

  /**
   * 메뉴를 **카테고리로 묶는다.**
   *
   * 항목이 열한 개가 되면서 평평한 목록으로는 무엇이 무엇인지 읽히지 않았다
   * ("정기점검" 과 "수집 로그" 와 "LLM 연결" 이 같은 높이로 붙어 있었다).
   * 묶음의 기준은 **무엇에 대한 화면인가** 다 — SR / 일정 / 참고 / 설정.
   *
   * 대시보드는 묶음 밖에 둔다. "지금 볼 것" 은 분류가 아니라 입구다.
   */
  const groups: Array<{
    title: string;
    items: Array<{ href: string; label: string; count: number | null; badge: number }>;
  }> = [
    {
      title: "",
      items: [{ href: "/dashboard", label: "대시보드", count: null, badge: 0 }],
    },
    {
      title: "서비스 요청",
      items: [
        { href: "/", label: "진행중", count: counts.open, badge: counts.unread },
        { href: "/closed", label: "종료", count: counts.closed, badge: 0 },
        { href: "/new", label: "SR 작성", count: null, badge: 0 },
      ],
    },
    {
      title: "일정 · 작업",
      items: [
        { href: "/calendar", label: "팀 캘린더", count: null, badge: 0 },
        { href: "/report", label: "정기점검", count: null, badge: 0 },
      ],
    },
    {
      title: "참고",
      items: [
        { href: "/cves", label: "보안 공지", count: counts.cves, badge: counts.criticalCves },
        { href: "/kb", label: "기술 문서", count: counts.kb, badge: counts.kbMatch },
      ],
    },
    {
      title: "설정 · 운영",
      items: [
        { href: "/team", label: "팀", count: null, badge: 0 },
        { href: "/settings/account", label: "브로드컴 계정", count: null, badge: 0 },
        // "연동 설정" 은 걷어냈다 — 아무 일도 하지 않는 화면이었다(app/settings/page.tsx).
        // `/settings` 는 LLM 연결로 리다이렉트된다.
        { href: "/settings/llm", label: "LLM 연결", count: null, badge: 0 },
        { href: "/logs", label: "수집 로그", count: null, badge: 0 },
      ],
    },
  ];
  const items = groups.flatMap((g) => g.items);

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
        <div style={{ fontSize: 12, color: COLOR.muted, marginTop: 2 }}>
          {user.teamName === "" ? "데이터솔루션 지원팀" : user.teamName}
        </div>
      </div>

      <nav style={{ padding: "12px 12px 16px", display: "flex", flexDirection: "column", overflowY: "auto" }}>
        {groups.map((group, gi) => (
          <div key={group.title === "" ? `g${gi}` : group.title} style={{ marginBottom: 10 }}>
            {group.title !== "" && (
              <div style={{
                fontSize: 10.5, fontWeight: 700, color: COLOR.faint, letterSpacing: "0.04em",
                padding: "8px 12px 5px", textTransform: "uppercase",
              }}>
                {group.title}
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {group.items.map((item) => {
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
            </div>
          </div>
        ))}
      </nav>

      <div style={{ marginTop: "auto" }}>
        {/*
          아래 두 칸은 **서로 다른 로그인**이다. 위가 이 도구를 쓰는 사람,
          아래가 공용 브로드컴 포털 세션이다. 섞이면 "로그아웃" 을 눌렀을 때
          수집이 멈추는 쪽을 끊어 버린다 — 그래서 라벨을 분명히 갈라 둔다.
        */}
        <div style={{ padding: "14px 20px", borderTop: `1px solid ${COLOR.divider}` }}>
          <UserChipRow user={user} />
        </div>

        <div style={{ padding: "14px 20px 16px", borderTop: `1px solid ${COLOR.divider}` }}>
          <div style={{ fontSize: 11, color: COLOR.faint, marginBottom: 7, fontWeight: 600 }}>
            브로드컴 포털 세션
          </div>
          {/*
            밑줄까지 SessionDot 이 그린다. 표시등은 포털에 물어 고쳐 그리는데 밑줄은
            쿠키 기준으로 남으면, 세션이 죽은 상태에서 "…까지" 가 같이 보여 엇갈린다.
          */}
          <SessionDot signedIn={signedIn} expiresAt={expiresAt} />
          <div style={{ marginTop: 9, paddingLeft: 15 }}>{authSlot}</div>
        </div>
      </div>
    </aside>
  );
}

/** 지금 로그인한 사람과 앱 로그아웃. */
function UserChipRow({ user }: { user: UserChip }) {
  const [busy, setBusy] = useState(false);

  async function signOut(): Promise<void> {
    setBusy(true);
    try {
      await fetch("/api/auth/signout", { method: "POST" });
      // 쿠키가 지워졌으므로 전체 이동으로 서버가 로그인 화면을 그리게 한다.
      window.location.href = "/signin";
    } catch {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 600, whiteSpace: "nowrap",
          overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {user.displayName === "" ? user.loginId : user.displayName}
          {user.role === "owner" && (
            <span style={{ color: COLOR.accent, fontSize: 10, marginLeft: 5, fontWeight: 700 }}>
              OWNER
            </span>
          )}
        </div>
        <div style={{
          fontSize: 11, color: COLOR.faint, fontFamily: MONO_STACK,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {user.loginId}
        </div>
      </div>
      <button
        type="button"
        onClick={signOut}
        disabled={busy}
        style={{
          fontSize: 11, color: COLOR.muted, background: "transparent",
          border: `1px solid ${COLOR.field}`, borderRadius: RADIUS.badge,
          padding: "4px 8px", cursor: "pointer", fontFamily: "inherit", flexShrink: 0,
        }}
      >
        {busy ? "…" : "로그아웃"}
      </button>
    </div>
  );
}
