/**
 * 화면 공통 부품.
 *
 * 색·글자·간격의 **값은 여기 없다** — `app/tokens.ts` 에 있다. 이 파일은 그 토큰으로
 * 조립한 부품을 둔다.
 *
 * ## 왜 부품이 필요한가
 *
 * 전에는 인라인 style 이 **888곳 / 67파일**에 흩어져 있었다(실측). 같은 버튼이 파일마다
 * 다시 그려졌고, 그래서 글자 크기가 14종·padding 조합이 40종 이상이 됐다. 손으로 쌓은
 * 일관성은 유지되지 않는다 — 다음 사람이 그 값을 모르기 때문이다.
 *
 * 아래 부품을 쓰면 값을 고를 일이 없다. 새 화면을 만들 때 **먼저 여기를 보고**, 없으면
 * 여기에 추가한다. 화면 파일에서 색을 직접 적기 시작하면 다시 888개로 돌아간다.
 *
 * 기존 export(`COLOR`·`RADIUS`·`controlStyle`·`Badge`·`Card`·`Notice`·`Mono`·
 * `statusColors`·`formatStamp`·`FONT_STACK`·`MONO_STACK`)는 **이름을 그대로 둔다** —
 * 67개 파일이 그 이름으로 쓰고 있다.
 */
import type { CSSProperties, ReactNode } from "react";
import {
  COLOR,
  FONT_STACK,
  LEADING,
  MONO_STACK,
  MOTION,
  RADIUS,
  SHADOW,
  SPACE,
  TEXT,
  WEIGHT,
} from "./tokens.ts";

export { COLOR, FONT_STACK, LEADING, MONO_STACK, MOTION, RADIUS, SHADOW, SPACE, TEXT, WEIGHT };
export { FOCUS_RING, BREAK } from "./tokens.ts";

/* ------------------------------------------------------------------ *
 * 글자
 * ------------------------------------------------------------------ */

/** 숫자. **항상 tabular** — 건수·날짜가 세로로 흔들리면 비교가 안 된다. */
export function Mono({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span style={{ fontFamily: MONO_STACK, fontVariantNumeric: "tabular-nums", ...style }}>
      {children}
    </span>
  );
}

/** 화면 제목 + 설명. 모든 페이지의 머리를 같은 모양으로 둔다. */
export function PageHeader({
  title, children, actions,
}: {
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header style={{ marginBottom: SPACE.xl }}>
      <div style={{
        display: "flex", alignItems: "flex-start", justifyContent: "space-between",
        gap: SPACE.md, flexWrap: "wrap",
      }}>
        <h1 style={{
          fontSize: TEXT.page, fontWeight: WEIGHT.bold, margin: 0,
          letterSpacing: "-0.02em", lineHeight: LEADING.tight, color: COLOR.ink,
        }}>
          {title}
        </h1>
        {actions !== undefined && (
          <div style={{ display: "flex", gap: SPACE.sm, flexWrap: "wrap" }}>{actions}</div>
        )}
      </div>
      {children !== undefined && (
        <p style={{
          margin: `${SPACE.sm}px 0 0`, fontSize: TEXT.base, color: COLOR.muted,
          lineHeight: LEADING.relaxed, maxWidth: 760,
        }}>
          {children}
        </p>
      )}
    </header>
  );
}

/** 카드 안의 섹션 제목. 오른쪽에 링크 하나를 둘 수 있다. */
export function SectionHead({
  title, right,
}: {
  title: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "baseline", justifyContent: "space-between",
      gap: SPACE.md, marginBottom: SPACE.md,
    }}>
      <h2 style={{
        fontSize: TEXT.lead, fontWeight: WEIGHT.bold, margin: 0,
        letterSpacing: "-0.01em", color: COLOR.ink,
      }}>
        {title}
      </h2>
      {right}
    </div>
  );
}

/** 작은 라벨. 입력칸 위, 표 머리. */
export function Label({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <>
      <div style={{
        fontSize: TEXT.small, fontWeight: WEIGHT.semibold, color: COLOR.body,
        marginBottom: hint === undefined ? SPACE.xs : SPACE.xxs,
      }}>
        {children}
      </div>
      {hint !== undefined && (
        <p style={{
          margin: `0 0 ${SPACE.xs}px`, fontSize: TEXT.micro, color: COLOR.faint,
          lineHeight: LEADING.normal,
        }}>
          {hint}
        </p>
      )}
    </>
  );
}

/**
 * 비어 있음.
 *
 * 비어 있는 것과 못 읽은 것은 다르다. 빈 칸을 조용히 두면 사람은 고장으로 읽는다.
 */
export function Empty({ children }: { children: ReactNode }) {
  return (
    <p style={{
      margin: 0, fontSize: TEXT.small, color: COLOR.faint, lineHeight: LEADING.relaxed,
    }}>
      {children}
    </p>
  );
}

/* ------------------------------------------------------------------ *
 * 면
 * ------------------------------------------------------------------ */

/**
 * 카드. **그림자가 없다** — 테두리로 구획한다(app/tokens.ts SHADOW 머리말).
 *
 * `flush` 는 안쪽 여백을 없앤다. 표나 격자를 카드 테두리에 붙일 때 쓴다.
 */
export function Card({
  children, style, flush,
}: {
  children: ReactNode;
  style?: CSSProperties;
  flush?: boolean;
}) {
  return (
    <div style={{
      background: COLOR.surface,
      border: `1px solid ${COLOR.line}`,
      borderRadius: RADIUS.card,
      padding: flush === true ? 0 : SPACE.lg,
      overflow: flush === true ? "hidden" : undefined,
      ...style,
    }}>
      {children}
    </div>
  );
}

/** 카드들을 같은 간격으로 깐다. 좁은 화면에서 한 줄로 내려온다. */
export function CardGrid({ children, min = 300 }: { children: ReactNode; min?: number }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`,
      gap: SPACE.lg,
      alignItems: "start",
    }}>
      {children}
    </div>
  );
}

export function Notice({
  tone, children,
}: {
  tone: "warn" | "error" | "ok" | "info";
  children: ReactNode;
}) {
  const map = {
    warn: { fg: COLOR.warn, bg: COLOR.warnBg, border: COLOR.warnLine },
    error: { fg: COLOR.waitUs, bg: COLOR.waitUsBg, border: COLOR.waitUsLine },
    ok: { fg: COLOR.ok, bg: COLOR.okBg, border: COLOR.okLine },
    info: { fg: COLOR.waitThem, bg: COLOR.waitThemBg, border: COLOR.waitThemLine },
  }[tone];
  return (
    <div style={{
      background: map.bg, color: map.fg, border: `1px solid ${map.border}`,
      borderRadius: RADIUS.card, padding: `${SPACE.md}px ${SPACE.lg}px`,
      marginBottom: SPACE.lg, lineHeight: LEADING.relaxed, fontSize: TEXT.base,
    }}>
      {children}
    </div>
  );
}

export function Badge({
  children, fg, bg, strong = false,
}: {
  children: ReactNode;
  fg: string;
  bg: string;
  strong?: boolean;
}) {
  return (
    <span style={{
      background: bg, color: fg, padding: `${SPACE.xxs}px ${SPACE.sm}px`,
      borderRadius: RADIUS.badge, fontSize: TEXT.micro,
      fontWeight: strong ? WEIGHT.semibold : WEIGHT.medium,
      whiteSpace: "nowrap", display: "inline-block", flexShrink: 0,
      lineHeight: 1.5,
    }}>
      {children}
    </span>
  );
}

/** 숫자 배지. 기다리는 일의 수처럼 **세어야 하는** 값에 쓴다. */
export function CountBadge({ value, tone = "alert" }: { value: number; tone?: "alert" | "quiet" }) {
  if (value <= 0) return null;
  return (
    <span style={{
      fontFamily: MONO_STACK, fontVariantNumeric: "tabular-nums",
      fontSize: TEXT.micro, fontWeight: WEIGHT.semibold,
      color: tone === "alert" ? COLOR.onAccent : COLOR.muted,
      background: tone === "alert" ? COLOR.waitUs : COLOR.subtle,
      padding: `1px ${SPACE.xs + 2}px`, borderRadius: RADIUS.badge, lineHeight: 1.6,
    }}>
      {value}
    </span>
  );
}

/** 포털 상태 문자열에 따른 색. 상태값은 포털이 주는 그대로 쓴다. */
export function statusColors(status: string): { fg: string; bg: string } {
  const s = status.toLowerCase();
  if (s.includes("closed") || s.includes("resolved") || s.includes("cancel")) {
    return { fg: COLOR.muted, bg: COLOR.subtle };
  }
  if (s.includes("pending customer")) return { fg: COLOR.waitUs, bg: COLOR.waitUsBg };
  if (s.includes("pending")) return { fg: COLOR.waitThem, bg: COLOR.waitThemBg };
  return { fg: COLOR.ok, bg: COLOR.okBg };
}

/* ------------------------------------------------------------------ *
 * 조작
 * ------------------------------------------------------------------ */

/**
 * 버튼·입력칸의 바탕 모양.
 *
 * `boxSizing` 이 꼭 필요하다. 전역 CSS 리셋이 없어서 브라우저 기본값(content-box)이
 * 그대로 먹고, 그러면 `width:100%` 인 칸이 여백+테두리만큼 더 넓어져 옆 칸을 덮는다.
 */
export const controlStyle: CSSProperties = {
  padding: `${SPACE.sm}px ${SPACE.md}px`,
  fontSize: TEXT.base,
  fontWeight: WEIGHT.medium,
  lineHeight: 1.5,
  color: COLOR.ink,
  background: COLOR.surface,
  border: `1px solid ${COLOR.field}`,
  borderRadius: RADIUS.control,
  cursor: "pointer",
  fontFamily: "inherit",
  boxSizing: "border-box",
  transition: `background ${MOTION.fast}, border-color ${MOTION.fast}`,
};

/** 입력칸. `controlStyle` 에서 커서만 글자로 바꾼다. */
export const inputStyle: CSSProperties = {
  ...controlStyle,
  cursor: "text",
  fontWeight: WEIGHT.normal,
  width: "100%",
};

/**
 * 버튼.
 *
 * `primary` 는 **화면당 하나**가 원칙이다. 둘이면 어느 쪽이 주인지 알 수 없다.
 * `danger` 는 되돌릴 수 없는 것에만.
 */
export function Button({
  children, onClick, kind = "default", size = "base", disabled, title, type = "button", full,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: "primary" | "default" | "quiet" | "danger";
  size?: "base" | "small";
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
  full?: boolean;
}) {
  const tone = {
    primary: { color: COLOR.onAccent, background: COLOR.accent, border: COLOR.accent },
    default: { color: COLOR.ink, background: COLOR.surface, border: COLOR.field },
    quiet: { color: COLOR.muted, background: "transparent", border: "transparent" },
    danger: { color: COLOR.waitUs, background: COLOR.surface, border: COLOR.waitUsLine },
  }[kind];

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        ...controlStyle,
        color: tone.color,
        background: tone.background,
        border: `1px solid ${tone.border}`,
        fontWeight: kind === "primary" ? WEIGHT.semibold : WEIGHT.medium,
        padding: size === "small"
          ? `${SPACE.xs + 1}px ${SPACE.sm + 2}px`
          : `${SPACE.sm}px ${SPACE.lg - 2}px`,
        fontSize: size === "small" ? TEXT.small : TEXT.base,
        width: full === true ? "100%" : undefined,
        // 끌 수 없는 버튼을 눌러 보는 일이 없게 커서까지 바꾼다.
        cursor: disabled === true ? "default" : "pointer",
        opacity: disabled === true ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

/** 링크처럼 보이는 버튼. 글 안에 섞일 때. */
export function LinkButton({
  children, onClick, tone = "accent", disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: "accent" | "danger" | "quiet";
  disabled?: boolean;
}) {
  const color = { accent: COLOR.accent, danger: COLOR.waitUs, quiet: COLOR.muted }[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        background: "transparent", border: "none", padding: 0,
        color, fontSize: TEXT.small, fontWeight: WEIGHT.semibold,
        fontFamily: "inherit", cursor: disabled === true ? "default" : "pointer",
        opacity: disabled === true ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

/** 탭 하나. 입력 방식 전환처럼 **같은 자리에 다른 내용**을 둘 때. */
export function Tab({
  active, onClick, children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        ...controlStyle,
        padding: `${SPACE.xs + 2}px ${SPACE.md}px`,
        fontSize: TEXT.small,
        fontWeight: active ? WEIGHT.bold : WEIGHT.medium,
        color: active ? COLOR.accent : COLOR.body,
        background: active ? COLOR.accentWash : COLOR.surface,
        border: `1px solid ${active ? COLOR.accent : COLOR.field}`,
      }}
    >
      {children}
    </button>
  );
}

/**
 * 고를 수 있는 값 하나(망·법인·성격, 목록 필터). 라디오보다 눌러야 할 것이 분명하다.
 *
 * `count` 를 주면 건수를 함께 보여 준다 — 필터로 쓸 때 "눌러 봐야 몇 건인지 아는"
 * 상황을 없앤다. 숫자는 tabular 라서 칩 폭이 들쭉날쭉하지 않다.
 *
 * `tone="danger"` 는 **내 차례**를 뜻하는 필터에만 쓴다(새 답변 등). 강조색을 여러
 * 뜻으로 쓰면 "빨간 건 내 차례" 규칙이 무너진다.
 */
export function Chip({
  label, active, onClick, count, tone = "accent",
}: {
  label: ReactNode;
  active: boolean;
  onClick: () => void;
  count?: number;
  tone?: "accent" | "danger";
}) {
  const mark = tone === "danger" ? COLOR.waitUs : COLOR.accent;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: SPACE.xs + 2,
        padding: `${SPACE.xs + 1}px ${SPACE.md - 1}px`,
        borderRadius: RADIUS.pill,
        fontSize: TEXT.small,
        fontWeight: active ? WEIGHT.semibold : WEIGHT.normal,
        fontFamily: "inherit",
        cursor: "pointer",
        border: `1px solid ${active ? mark : COLOR.field}`,
        background: active ? mark : COLOR.surface,
        color: active ? COLOR.onAccent : COLOR.body,
        transition: `background ${MOTION.fast}, border-color ${MOTION.fast}`,
      }}
    >
      {label}
      {count !== undefined && (
        <span style={{
          fontFamily: MONO_STACK,
          fontSize: TEXT.micro,
          fontVariantNumeric: "tabular-nums",
          // 눌린 칩 안에서는 바탕이 진하므로 흰색을 옅게 깔아 둔다.
          color: active ? "rgba(255,255,255,.72)" : COLOR.faint,
        }}>
          {count}
        </span>
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * 날짜
 * ------------------------------------------------------------------ */

/**
 * 로케일에 의존하지 않는 날짜 표기.
 *
 * `toLocaleString` 은 Node 의 ICU 와 브라우저의 결과가 달라서(예: "AM 02:52" vs
 * "오전 02:52") 클라이언트 컴포넌트에서 쓰면 하이드레이션 불일치가 난다. 직접 만든다.
 */
export function formatStamp(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "-";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "-";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
