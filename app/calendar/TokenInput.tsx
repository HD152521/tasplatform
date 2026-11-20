"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  activeToken,
  applySuggestion,
  filterSuggestions,
  memberSuggestions,
  tagSuggestions,
  type Trigger,
} from "../../lib/tokenSuggest.ts";
import { COLOR, MONO_STACK, RADIUS, controlStyle } from "../ui.tsx";
import type { MemberChip } from "./CalendarBoard.tsx";

export type { Trigger } from "../../lib/tokenSuggest.ts";
/**
 * `@`·`#` 를 치면 **목록이 뜨는** 입력칸.
 *
 * ## 왜 필요한가
 *
 * 망·법인·성격·팀원은 **정해진 값**이다. 그걸 외워서 적게 하면 틀리게 적고, 틀린 태그는
 * 조용히 "성격" 으로 떨어져 Jira 제목의 대괄호가 비어 버린다. 목록이 뜨면 외울 것이
 * 없고, 각 값이 Jira 의 **어디로 가는지**(대괄호·에픽·라벨)도 거기서 읽힌다.
 *
 * ## 키보드
 *
 * ↑↓ 로 고르고 Enter·Tab 으로 넣는다. **목록이 떠 있는 동안 Enter 는 등록이 아니다** —
 * 고르려고 누른 Enter 가 일정을 등록해 버리면, 태그가 반쯤 적힌 일정이 저장된다.
 * Esc 로 목록만 닫는다(입력은 지우지 않는다).
 */
export function TokenInput({
  value, onChange, onSubmit, members, triggers, multiline, placeholder, disabled, inputStyle, rows,
  focusRef,
}: {
  value: string;
  onChange: (next: string) => void;
  /** 목록이 닫혀 있을 때 Enter. 없으면 Enter 가 줄바꿈(여러 줄)이거나 아무 일도 안 한다. */
  onSubmit?: () => void;
  members: readonly MemberChip[];
  triggers: readonly Trigger[];
  multiline?: boolean;
  placeholder?: string;
  disabled?: boolean;
  inputStyle?: React.CSSProperties;
  rows?: number;
  /**
   * 부모가 포커스를 주려고 들고 가는 참조.
   *
   * 날짜 칸을 누르면 입력칸으로 커서가 가야 하고(`n` 키도 그렇다), 그러려면 부모가
   * 이 안의 element 를 만질 수 있어야 한다.
   */
  focusRef?: React.MutableRefObject<HTMLInputElement | HTMLTextAreaElement | null>;
}) {
  const own = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const ref = focusRef ?? own;
  const [caret, setCaret] = useState(0);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState(0);

  const token = useMemo(() => activeToken(value, caret, triggers), [value, caret, triggers]);
  const items = useMemo(() => {
    if (token === null) return [];
    const all = token.trigger === "@" ? memberSuggestions(members) : tagSuggestions();
    return filterSuggestions(all, token.query).slice(0, 8);
  }, [token, members]);

  // 토큰이 바뀌면 고른 자리를 처음으로 돌린다 — 안 그러면 목록이 줄었을 때
  // 보이지 않는 항목이 골라져 있다.
  useEffect(() => {
    setPicked(0);
  }, [token?.trigger, token?.query]);

  const visible = open && token !== null && items.length > 0;

  function choose(index: number): void {
    const item = items[index];
    if (item === undefined || token === null) return;
    const applied = applySuggestion(value, token, caret, item.insert);
    onChange(applied.text);
    setOpen(false);

    // 커서를 넣은 토큰 뒤로 옮긴다. 다음 글자를 바로 칠 수 있어야 한다.
    const position = applied.caret;
    window.requestAnimationFrame(() => {
      const el = ref.current;
      if (el === null) return;
      el.focus();
      el.setSelectionRange(position, position);
      setCaret(position);
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void {
    if (visible) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPicked((p) => (p + 1) % items.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPicked((p) => (p - 1 + items.length) % items.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        // 고르려고 누른 Enter 가 일정을 등록해 버리면 안 된다.
        e.preventDefault();
        choose(picked);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
    }
    if (e.key === "Enter" && onSubmit !== undefined && multiline !== true) {
      e.preventDefault();
      onSubmit();
    }
  }

  /** 커서 위치는 입력·클릭·키 이동 모두에서 바뀐다. 한 곳에서 읽는다. */
  function syncCaret(): void {
    const el = ref.current;
    if (el !== null) setCaret(el.selectionStart ?? el.value.length);
  }

  const shared = {
    ref: ref as never,
    value,
    disabled,
    placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      onChange(e.target.value);
      setCaret(e.target.selectionStart ?? e.target.value.length);
      setOpen(true);
    },
    onKeyUp: syncCaret,
    onClick: syncCaret,
    onFocus: () => {
      syncCaret();
      setOpen(true);
    },
    // 바로 닫으면 항목을 누르는 순간 목록이 사라져 클릭이 먹지 않는다.
    onBlur: () => window.setTimeout(() => setOpen(false), 150),
    onKeyDown,
    style: { ...controlStyle, width: "100%", cursor: "text", ...inputStyle },
  };

  return (
    <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
      {multiline === true ? (
        <textarea
          {...shared}
          rows={rows ?? 4}
          style={{ ...shared.style, height: "auto", resize: "vertical", lineHeight: 1.7 }}
        />
      ) : (
        <input {...shared} />
      )}

      {visible && (
        <ul style={{
          position: "absolute", zIndex: 40, left: 0, right: 0, top: "calc(100% + 4px)",
          listStyle: "none", margin: 0, padding: 4,
          background: COLOR.surface, border: `1px solid ${COLOR.line}`,
          borderRadius: RADIUS.control, boxShadow: "0 8px 24px rgba(16,24,40,0.12)",
          maxHeight: 260, overflowY: "auto",
        }}>
          {items.map((item, index) => (
            <li key={`${item.group}-${item.insert}`}>
              <button
                type="button"
                // onMouseDown 이어야 한다 — onClick 은 blur 가 먼저 가 목록이 닫힌 뒤에 온다.
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(index);
                }}
                onMouseEnter={() => setPicked(index)}
                style={{
                  display: "flex", alignItems: "center", gap: 8, width: "100%",
                  padding: "7px 9px", borderRadius: 6, border: "none", cursor: "pointer",
                  fontFamily: "inherit", textAlign: "left",
                  background: index === picked ? "#eef1f6" : "transparent",
                }}
              >
                <span style={{
                  fontSize: 10.5, fontWeight: 700, color: COLOR.faint, width: 38,
                  flexShrink: 0, letterSpacing: "0.02em",
                }}>
                  {item.group}
                </span>
                <span style={{ fontSize: 13, fontWeight: 600, color: COLOR.ink }}>
                  {token?.trigger}
                  {item.label}
                </span>
                <span style={{
                  marginLeft: "auto", fontSize: 11, color: COLOR.faint,
                  fontFamily: item.group === "팀원" ? MONO_STACK : "inherit",
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                }}>
                  {item.hint}
                </span>
              </button>
            </li>
          ))}
          <li style={{
            padding: "5px 9px 3px", fontSize: 10.5, color: COLOR.faint,
            borderTop: `1px solid ${COLOR.divider}`, marginTop: 3,
          }}>
            ↑↓ 고르기 · Enter·Tab 넣기 · Esc 닫기
          </li>
        </ul>
      )}
    </div>
  );
}
