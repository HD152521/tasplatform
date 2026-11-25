"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { activeNavHref } from "../lib/navActive.ts";
import { collapsedNames } from "../lib/navCollapse.ts";
import { COLOR, MONO_STACK, RADIUS, SPACE, TEXT, WEIGHT } from "./ui.tsx";
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

interface NavItem {
  href: string;
  label: string;
  count: number | null;
  badge: number;
}

interface NavGroup {
  /** 큰 카테고리 이름. 빈 문자열이면 묶음 없이 단독으로 그린다. */
  title: string;
  items: NavItem[];
}

/** 접힘 상태를 브라우저에 남겨 둘 키. */
const COLLAPSE_KEY = "sr_nav_collapsed";

/**
 * 좌측 네비게이션.
 *
 * 세로로 둔 이유는 각 항목의 건수를 항상 보이게 하기 위해서다 — "어디에 몇 건이 있고,
 * 그중 몇 건이 내 확인을 기다리는가" 가 이 도구의 첫 질문이다.
 *
 * ## 큰 카테고리 · 세부 항목 · 접기
 *
 * 항목이 열두 개가 되면서 평평한 목록으로는 읽히지 않았다. 그래서 **큰 카테고리**로
 * 묶고, 카테고리를 **눌러 접을 수 있게** 했다. 매일 쓰는 것은 둘셋뿐이고 나머지(설정·
 * 로그)는 가끔 쓰는데, 그것들이 늘 펼쳐져 있으면 쓰는 것이 아래로 밀린다.
 *
 * 접힘 상태는 `localStorage` 에 남긴다 — 사람마다 접어 두는 것이 다르고, 그걸 서버에
 * 저장할 가치는 없다. 저장이 막힌 환경(사생활 보호 모드 등)에서도 **그냥 펼친 채로**
 * 동작해야 하므로 읽기·쓰기를 try 로 감싼다.
 *
 * **지금 보고 있는 화면이 든 카테고리는 접히지 않는다.** 접힌 채로 그 안의 항목이
 * 활성이면, 어디에 있는지 알 수 없는 상태가 된다.
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

  const groups: NavGroup[] = [
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
        { href: "/notes", label: "메모장", count: null, badge: 0 },
        { href: "/report", label: "정기점검", count: null, badge: 0 },
      ],
    },
    {
      title: "참고 자료",
      items: [
        { href: "/cves", label: "보안 공지", count: counts.cves, badge: counts.criticalCves },
        { href: "/kb", label: "기술 문서", count: counts.kb, badge: counts.kbMatch },
      ],
    },
    {
      title: "팀 설정",
      items: [
        { href: "/team", label: "팀 · 팀원", count: null, badge: 0 },
        { href: "/settings/account", label: "브로드컴 계정", count: null, badge: 0 },
        // "연동 설정" 은 걷어냈다 — 아무 일도 하지 않는 화면이었다(app/settings/page.tsx).
        // `/settings` 는 LLM 연결로 리다이렉트된다.
        { href: "/settings/llm", label: "LLM 연결", count: null, badge: 0 },
      ],
    },
    {
      title: "내 설정 · 운영",
      items: [
        { href: "/me", label: "내 설정", count: null, badge: 0 },
        { href: "/logs", label: "수집 로그", count: null, badge: 0 },
      ],
    },
  ];

  // 지금 어느 항목에 있나. **가장 깊게 맞는 것 하나만** 켠다.
  //
  // 전에는 `path.startsWith(item.href)` 였다. 그러면 `/settings/llm` 에서 `/settings`
  // 도 걸려 **두 항목이 같이 켜져 보였다** — 어디에 있는지 알 수 없다.
  // 이 규칙은 lib/navActive.ts 에 두고 단위 시험으로 잠근다.
  const activeHref = activeNavHref(path, groups.flatMap((g) => g.items).map((i) => i.href));

  const [collapsed, setCollapsed] = useState<readonly string[]>([]);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(COLLAPSE_KEY);
      if (raw !== null) setCollapsed(collapsedNames(JSON.parse(raw)));
    } catch {
      // 저장이 막힌 환경에서도 그냥 펼친 채로 동작한다.
      // 망가진 JSON 도 여기로 온다(parse 가 던진다) — 그냥 펼친 채로 둔다.
    }
  }, []);

  function toggle(title: string): void {
    setCollapsed((prev) => {
      const next = prev.includes(title) ? prev.filter((t) => t !== title) : [...prev, title];
      try {
        window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        // 못 저장해도 이번 화면에서는 접힌다.
      }
      return next;
    });
  }

  return (
    <aside style={{
      width: 268, flexShrink: 0, background: COLOR.surface,
      borderRight: `1px solid ${COLOR.line}`,
      display: "flex", flexDirection: "column",
      position: "sticky", top: 0, height: "100vh",
    }}>
      <div style={{ padding: `${SPACE.xl}px ${SPACE.xl}px ${SPACE.lg}px`, borderBottom: `1px solid ${COLOR.divider}` }}>
        <div style={{ fontSize: TEXT.lead, fontWeight: WEIGHT.bold, letterSpacing: "-0.01em" }}>Broadcom SR</div>
        <div style={{ fontSize: TEXT.small, color: COLOR.muted, marginTop: SPACE.xxs }}>
          {user.teamName === "" ? "소속 팀 없음" : user.teamName}
        </div>
      </div>

      <nav style={{ padding: `${SPACE.sm}px ${SPACE.md}px ${SPACE.lg}px`, display: "flex", flexDirection: "column", overflowY: "auto" }}>
        {groups.map((group, gi) => {
          const hasActive = group.items.some((i) => i.href === activeHref);
          // 보고 있는 화면이 든 카테고리는 접지 않는다 — 접힌 채 활성이면 길을 잃는다.
          const open = group.title === "" || hasActive || !collapsed.includes(group.title);
          const hidden = open ? 0 : groupBadge(group);
          return (
            <div key={group.title === "" ? `g${gi}` : group.title} style={{ marginBottom: SPACE.xs }}>
              {group.title !== "" && (
                <button
                  type="button"
                  onClick={() => toggle(group.title)}
                  aria-expanded={open}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    // 줄바꿈을 **막는다.** 제목·숫자·화살표가 한 줄에 있어야 "이 묶음에 N건" 이
                    // 한눈에 붙는다. flex 는 기본이 nowrap 이지만, 전역 스타일 하나로 뒤집히면
                    // 숫자가 아래 줄로 떨어진다 — 여기서 못 박는다.
                    flexWrap: "nowrap",
                    gap: SPACE.sm,
                    width: "100%", background: "transparent", border: "none",
                    padding: `${SPACE.sm}px ${SPACE.md}px ${SPACE.xs}px`, cursor: hasActive ? "default" : "pointer",
                    fontFamily: "inherit", textAlign: "left",
                  }}
                >
                  <span style={{
                    fontSize: TEXT.micro, fontWeight: WEIGHT.bold, color: COLOR.faint,
                    letterSpacing: "0.04em", whiteSpace: "nowrap",
                    // minWidth:0 이 없으면 flex 항목은 글 길이만큼 버틴다 — 긴 제목이
                    // 숫자를 밀어내고, 그때 줄이 깨진다. 줄이는 것은 제목 쪽이 맞다.
                    minWidth: 0, flex: "1 1 auto",
                    overflow: "hidden", textOverflow: "ellipsis",
                  }}>
                    {group.title}
                  </span>
                  {/*
                    접었을 때 합쳐지는 숫자는 **카테고리 줄 안**, 화살표 왼쪽에 둔다.
                    전에는 버튼 아래 별도 줄에 그렸다 — 숫자 하나가 한 줄을 차지해
                    접어서 줄인 높이를 거의 그대로 돌려받았고, 무엇의 숫자인지도
                    멀어 보였다. 제목과 같은 줄에 있으면 "이 묶음에 N건" 이 한눈에 붙는다.
                  */}
                  <span style={{ display: "flex", alignItems: "center", gap: SPACE.xs, flexShrink: 0 }}>
                    {hidden > 0 && (
                      <span style={{
                        fontFamily: MONO_STACK, fontVariantNumeric: "tabular-nums",
                        fontSize: TEXT.micro, fontWeight: WEIGHT.semibold, color: COLOR.surface,
                        background: COLOR.waitUs, padding: `${SPACE.xxs}px ${SPACE.xs}px`,
                        borderRadius: RADIUS.badge, lineHeight: 1.2,
                      }}>
                        {hidden}
                      </span>
                    )}
                    <span style={{
                      fontSize: TEXT.micro, color: COLOR.faint,
                      // 접힘은 눌러서 바뀌는 것이니 화살표가 그 상태를 말한다.
                      transform: open ? "rotate(90deg)" : "none",
                      transition: "transform 120ms ease",
                    }}>
                      ▶
                    </span>
                  </span>
                </button>
              )}

              {open && (
                <div style={{ display: "flex", flexDirection: "column", gap: SPACE.xxs }}>
                  {group.items.map((item) => (
                    <NavLink key={item.href} item={item} active={item.href === activeHref} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div style={{ marginTop: "auto" }}>
        {/*
          아래 두 칸은 **서로 다른 로그인**이다. 위가 이 도구를 쓰는 사람,
          아래가 그 팀이 공유하는 브로드컴 포털 세션이다. 섞이면 "로그아웃" 을 눌렀을 때
          수집이 멈추는 쪽을 끊어 버린다 — 그래서 라벨을 분명히 갈라 둔다.
        */}
        <div style={{ padding: `${SPACE.md}px ${SPACE.xl}px`, borderTop: `1px solid ${COLOR.divider}` }}>
          <UserChipRow user={user} />
        </div>

        <div style={{ padding: `${SPACE.md}px ${SPACE.xl}px ${SPACE.lg}px`, borderTop: `1px solid ${COLOR.divider}` }}>
          <div style={{ fontSize: TEXT.micro, color: COLOR.faint, marginBottom: SPACE.sm, fontWeight: WEIGHT.semibold }}>
            브로드컴 포털 세션 {user.teamName === "" ? "" : `· ${user.teamName}`}
          </div>
          {/*
            밑줄까지 SessionDot 이 그린다. 표시등은 포털에 물어 고쳐 그리는데 밑줄은
            쿠키 기준으로 남으면, 세션이 죽은 상태에서 "…까지" 가 같이 보여 엇갈린다.
          */}
          <SessionDot signedIn={signedIn} expiresAt={expiresAt} />
          <div style={{ marginTop: SPACE.sm, paddingLeft: SPACE.lg }}>{authSlot}</div>
        </div>
      </div>
    </aside>
  );
}

/** 접힌 카테고리가 숨기고 있는 "기다리는 일" 의 수. */
function groupBadge(group: NavGroup): number {
  return group.items.reduce((sum, item) => sum + item.badge, 0);
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link href={item.href} style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      // 묶음 제목과 같은 이유로 줄바꿈을 막는다(위 주석). 이름이 길면 이름을 줄인다.
      flexWrap: "nowrap", gap: SPACE.sm,
      padding: `${SPACE.sm}px ${SPACE.md}px`, borderRadius: 8, fontSize: TEXT.base, textDecoration: "none",
      fontWeight: active ? 600 : 400,
      color: active ? COLOR.ink : COLOR.body,
      background: active ? COLOR.accentWash : "transparent",
    }}>
      <span style={{
        display: "flex", alignItems: "center", gap: SPACE.sm,
        minWidth: 0, flex: "1 1 auto", overflow: "hidden",
      }}>
        <span style={{
          width: 5, height: 5, borderRadius: "50%", flexShrink: 0,
          background: active ? COLOR.accent : COLOR.line,
        }} />
        {/* 이름은 한 줄로 두고 넘치면 … 로 줄인다. 두 줄이 되면 숫자가 따라 내려간다. */}
        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {item.label}
        </span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: SPACE.xs, flexShrink: 0 }}>
        {item.badge > 0 && (
          <span style={{
            fontFamily: MONO_STACK, fontSize: TEXT.micro, fontWeight: WEIGHT.semibold, color: COLOR.surface,
            background: COLOR.waitUs, padding: `${SPACE.xxs}px ${SPACE.xs}px`, borderRadius: RADIUS.badge,
          }}>
            {item.badge}
          </span>
        )}
        {item.count !== null && (
          <span style={{
            fontFamily: MONO_STACK, fontVariantNumeric: "tabular-nums",
            fontSize: TEXT.small, color: COLOR.faint,
          }}>
            {item.count}
          </span>
        )}
      </span>
    </Link>
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
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: SPACE.sm }}>
      <Link href="/me" style={{ minWidth: 0, textDecoration: "none", color: "inherit" }}>
        <div style={{
          fontSize: TEXT.base, fontWeight: WEIGHT.semibold, whiteSpace: "nowrap",
          overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {user.displayName === "" ? user.loginId : user.displayName}
          {user.role === "owner" && (
            <span style={{ color: COLOR.accent, fontSize: TEXT.micro, marginLeft: SPACE.xs, fontWeight: WEIGHT.bold }}>
              OWNER
            </span>
          )}
        </div>
        <div style={{
          fontSize: TEXT.micro, color: COLOR.faint, fontFamily: MONO_STACK,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {user.loginId}
        </div>
      </Link>
      <button
        type="button"
        onClick={signOut}
        disabled={busy}
        style={{
          fontSize: TEXT.micro, color: COLOR.muted, background: "transparent",
          border: `1px solid ${COLOR.field}`, borderRadius: RADIUS.badge,
          padding: `${SPACE.xs}px ${SPACE.sm}px`, cursor: "pointer", fontFamily: "inherit", flexShrink: 0,
        }}
      >
        {busy ? "…" : "로그아웃"}
      </button>
    </div>
  );
}
