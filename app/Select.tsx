"use client";

/**
 * 드롭다운.
 *
 * 네이티브 `<select>` 를 대신한다. 두 가지 때문이다.
 *
 *   1) **위로 뜬다.** 브라우저는 고른 항목을 커서 아래에 두려고 목록을 올려 띄운다.
 *      항목이 열다섯 개쯤 되면 목록이 길어 위로 열리는 일이 잦은데, CSS 로는 못 막는다.
 *      여기서는 **아래로 여는 것이 기본**이고, 아래 자리가 정말 모자랄 때만 뒤집는다.
 *   2) 네이티브 목록은 서식을 못 입힌다. 글꼴·간격·고른 항목 표시가 앱과 따로 논다.
 *
 * 키보드와 ARIA 는 직접 챙긴다 — 위/아래로 옮기고, Enter 로 고르고, Esc 로 닫고,
 * 글자를 치면 그 글자로 시작하는 항목으로 건너뛴다.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { COLOR, RADIUS } from "./ui.tsx";

export interface SelectOption<T extends string | number> {
  readonly value: T;
  readonly label: string;
}

/** 목록 최대 높이. 이보다 길면 목록 안에서 스크롤한다. */
const LIST_MAX = 288;
/** 글자를 이만큼 안 치면 건너뛰기 버퍼를 비운다. */
const TYPE_RESET_MS = 900;

export function Select<T extends string | number>({
  value, options, onChange, ariaLabel, disabled = false, placeholder = "선택",
}: {
  value: T;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  /** 열 때 남은 자리에 맞춰 잘라 둔 목록 높이. */
  const [maxH, setMaxH] = useState(LIST_MAX);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typed = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const id = useId();

  const selected = useMemo(
    () => options.findIndex((o) => o.value === value),
    [options, value],
  );
  const current = selected >= 0 ? options[selected] : undefined;

  /**
   * 열 때 자리를 재서 방향과 높이를 정한다.
   *
   * **아래가 먼저다.** 아래가 모자라고 위가 더 넓을 때만 뒤집는다. 그리고 어느 쪽이든
   * 남은 자리에 맞춰 높이를 자른다 — 안 자르면 뒤집었을 때 목록이 화면 위로 삐져나가
   * 첫 항목을 못 본다(실측: 420px 화면에서 23px 잘림).
   */
  function openList(): void {
    const box = root.current?.getBoundingClientRect();
    if (box) {
      const GAP = 12; // 화면 가장자리에 붙지 않게 두는 여백
      const below = window.innerHeight - box.bottom - GAP;
      const above = box.top - GAP;
      const up = below < Math.min(LIST_MAX, 160) && above > below;
      setDropUp(up);
      // maxHeight 는 스크롤 영역만 재므로, 목록의 테두리·안쪽여백과 트리거와의 간격을
      // 빼 둬야 실제로 그 자리에 들어간다(안 빼면 3px 씩 삐져나간다).
      const CHROME = 15;
      setMaxH(Math.max(120, Math.min(LIST_MAX, (up ? above : below) - CHROME)));
    }
    setActive(selected >= 0 ? selected : 0);
    setOpen(true);
  }

  // 바깥을 누르거나 Esc 면 닫는다.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // 고른 항목이 보이게 스크롤한다.
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function pick(index: number): void {
    const option = options[index];
    if (option === undefined) return;
    onChange(option.value);
    setOpen(false);
  }

  /** 친 글자로 시작하는 항목을 찾는다. 같은 글자를 이어 치면 그 글자들로 찾는다. */
  function jumpTo(char: string): void {
    const now = Date.now();
    const text = (now - typed.current.at < TYPE_RESET_MS ? typed.current.text : "") + char;
    typed.current = { text, at: now };
    const lower = text.toLowerCase();
    const found = options.findIndex((o) => o.label.toLowerCase().startsWith(lower));
    if (found >= 0) {
      setActive(found);
      if (!open) pick(found);
    }
  }

  function onKey(e: React.KeyboardEvent): void {
    if (disabled) return;
    const move = (next: number): void => {
      e.preventDefault();
      const wrapped = (next + options.length) % options.length;
      if (open) setActive(wrapped); else pick(wrapped);
    };

    switch (e.key) {
      case "ArrowDown": return move((open ? active : selected) + 1);
      case "ArrowUp": return move((open ? active : selected) - 1);
      case "Home": return move(0);
      case "End": return move(options.length - 1);
      case "Enter":
      case " ":
        e.preventDefault();
        if (open) pick(active); else openList();
        return;
      case "Escape":
        if (open) { e.preventDefault(); setOpen(false); }
        return;
      case "Tab":
        setOpen(false);
        return;
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) jumpTo(e.key);
    }
  }

  return (
    <div ref={root} style={{ position: "relative" }}>
      <button
        type="button" disabled={disabled} onKeyDown={onKey}
        onClick={() => (open ? setOpen(false) : openList())}
        aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}
        style={{
          width: "100%", boxSizing: "border-box", height: 38,
          display: "flex", alignItems: "center", gap: 8,
          padding: "0 11px", fontSize: 13, lineHeight: 1.6, fontFamily: "inherit",
          textAlign: "left", color: current ? COLOR.ink : COLOR.faint,
          background: disabled ? COLOR.ground : COLOR.surface,
          border: `1px solid ${open ? COLOR.accent : COLOR.field}`,
          borderRadius: RADIUS.control, outline: "none",
          boxShadow: open ? `0 0 0 3px ${COLOR.waitThemBg}` : "none",
          cursor: disabled ? "default" : "pointer",
        }}
      >
        <span style={{
          flex: 1, minWidth: 0, overflow: "hidden",
          textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {current?.label ?? placeholder}
        </span>
        <Chevron up={open && dropUp} />
      </button>

      {open && (
        <ul
          ref={list} role="listbox" aria-label={ariaLabel} tabIndex={-1}
          aria-activedescendant={`${id}-${active}`}
          style={{
            position: "absolute", left: 0, right: 0, zIndex: 40,
            ...(dropUp ? { bottom: "100%", marginBottom: 5 } : { top: "100%", marginTop: 5 }),
            maxHeight: maxH, overflowY: "auto",
            listStyle: "none", padding: 4,
            background: COLOR.surface,
            border: `1px solid ${COLOR.field}`, borderRadius: RADIUS.control,
            boxShadow: "0 8px 24px rgba(20,23,26,.12)",
          } as React.CSSProperties}
        >
          {options.map((o, i) => {
            const on = i === selected;
            const hot = i === active;
            return (
              <li
                key={String(o.value)} id={`${id}-${i}`} data-i={i}
                role="option" aria-selected={on}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); pick(i); }}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "7px 9px", borderRadius: 6, cursor: "pointer",
                  fontSize: 13, lineHeight: 1.5,
                  color: on ? COLOR.accentDeep : COLOR.ink,
                  fontWeight: on ? 600 : 400,
                  background: hot ? COLOR.ground : "transparent",
                }}
              >
                <span style={{ flex: 1, minWidth: 0, wordBreak: "break-word" }}>{o.label}</span>
                {on && <Check />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Chevron({ up }: { up: boolean }) {
  return (
    <svg width="11" height="7" viewBox="0 0 11 7" aria-hidden style={{
      flexShrink: 0, transform: up ? "rotate(180deg)" : undefined,
    }}>
      <path d="M1 1.5 5.5 6 10 1.5" fill="none" stroke={COLOR.muted}
            strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Check() {
  return (
    <svg width="12" height="9" viewBox="0 0 12 9" aria-hidden style={{ flexShrink: 0 }}>
      <path d="M1 4.5 4.5 8 11 1" fill="none" stroke={COLOR.accent}
            strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
