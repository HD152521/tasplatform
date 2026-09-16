/** 화면 공통 토큰과 조각. 색·간격·라운드를 한 곳에서 관리한다. */
import type { CSSProperties, ReactNode } from "react";

export const COLOR = {
  ink: "#14171a",
  body: "#374151",
  muted: "#6b7280",
  faint: "#9aa1ac",
  line: "#e5e7eb",
  divider: "#f0f1f4",
  field: "#dfe3e9",
  surface: "#ffffff",
  ground: "#f4f5f7",
  accent: "#1a56db",
  accentDeep: "#143f9e",
  /** 우리가 조치해야 하는 것 */
  waitUs: "#b42318",
  waitUsBg: "#fef3f2",
  /** 상대가 조치 중인 것 */
  waitThem: "#175cd3",
  waitThemBg: "#eff8ff",
  ok: "#067647",
  okBg: "#ecfdf3",
  warn: "#b54708",
  warnBg: "#fffaeb",
} as const;

/** 라운드 스케일. 카드 12 / 버튼·입력 8 / 배지 5 / 칩 999 */
export const RADIUS = { card: 12, control: 8, badge: 5, pill: 999 } as const;

export const FONT_STACK =
  "'IBM Plex Sans KR', -apple-system, 'Segoe UI', system-ui, sans-serif";
export const MONO_STACK = "ui-monospace, 'SF Mono', Consolas, monospace";

export function Mono({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span style={{ fontFamily: MONO_STACK, fontVariantNumeric: "tabular-nums", ...style }}>
      {children}
    </span>
  );
}

export function Badge({
  children, fg, bg, strong = false,
}: { children: ReactNode; fg: string; bg: string; strong?: boolean }) {
  return (
    <span style={{
      background: bg, color: fg, padding: "2px 8px", borderRadius: RADIUS.badge,
      fontSize: 11, fontWeight: strong ? 600 : 500, whiteSpace: "nowrap",
      display: "inline-block", flexShrink: 0,
    }}>
      {children}
    </span>
  );
}

/** 포털 상태 문자열에 따른 색. 상태값은 포털이 주는 그대로 쓴다. */
export function statusColors(status: string): { fg: string; bg: string } {
  const s = status.toLowerCase();
  if (s.includes("closed") || s.includes("resolved") || s.includes("cancel")) {
    return { fg: COLOR.muted, bg: COLOR.ground };
  }
  if (s.includes("pending customer")) return { fg: COLOR.waitUs, bg: COLOR.waitUsBg };
  if (s.includes("pending")) return { fg: COLOR.waitThem, bg: COLOR.waitThemBg };
  return { fg: COLOR.ok, bg: COLOR.okBg };
}

export function Card({
  children, style,
}: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{
      background: COLOR.surface, border: `1px solid ${COLOR.line}`,
      borderRadius: RADIUS.card, ...style,
    }}>
      {children}
    </div>
  );
}

export function Notice({
  tone, children,
}: { tone: "warn" | "error" | "ok"; children: ReactNode }) {
  const map = {
    warn: { fg: COLOR.warn, bg: COLOR.warnBg, border: "#f0d69a" },
    error: { fg: COLOR.waitUs, bg: COLOR.waitUsBg, border: "#f3c7c2" },
    ok: { fg: COLOR.ok, bg: COLOR.okBg, border: "#b9e6cd" },
  }[tone];
  return (
    <div style={{
      background: map.bg, color: map.fg, border: `1px solid ${map.border}`,
      borderRadius: RADIUS.card, padding: "14px 17px", marginBottom: 18,
      lineHeight: 1.65, fontSize: 13.5,
    }}>
      {children}
    </div>
  );
}

export const controlStyle: CSSProperties = {
  padding: "8px 13px",
  fontSize: 13,
  fontWeight: 500,
  color: COLOR.ink,
  background: COLOR.surface,
  border: `1px solid ${COLOR.field}`,
  borderRadius: RADIUS.control,
  cursor: "pointer",
  fontFamily: "inherit",
};

/**
 * 로케일에 의존하지 않는 날짜 표기.
 *
 * toLocaleString 은 Node 의 ICU 와 브라우저의 결과가 달라서
 * (예: "AM 02:52" vs "오전 02:52") 클라이언트 컴포넌트에서 쓰면
 * 하이드레이션 불일치가 난다. 직접 만든다.
 */
export function formatStamp(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "-";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "-";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
