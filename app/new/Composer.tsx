"use client";

/**
 * SR 본문 작업대.
 *
 * 칸은 하나다. 거기에 한국어로 쓰든 영어로 쓰든 적고, 버튼 둘 중 하나를 누르면
 * **그 자리에서** 바뀐다.
 *
 *   번역 — 한국어로 적었을 때. 팀 양식으로 정리하면서 영어로 옮긴다.
 *   정리 — 이미 영어로 적었을 때. 언어는 그대로 두고 모양만 다듬는다.
 *
 * 제자리에서 바꾸므로 **되돌리기**를 둔다. 한 번 누르면 직전 글로 돌아간다.
 * 이것이 없으면 잘못 누른 한 번에 쓴 글이 사라진다.
 */
import { useState } from "react";
import { COLOR, RADIUS } from "../ui.tsx";

export type ComposeMode = "translate" | "tidy";

export function Composer({
  subject, onSubject, subjectLimit,
  content, onContent,
  onCompose, composing, error, gaps,
}: {
  subject: string;
  onSubject: (v: string) => void;
  subjectLimit: number;
  content: string;
  onContent: (v: string) => void;
  onCompose: (mode: ComposeMode) => void;
  /** 돌고 있는 작업. 없으면 null. */
  composing: ComposeMode | null;
  error: string;
  /** 원문에 없어 담당자가 채워야 할 것들. */
  gaps: readonly string[];
}) {
  /** 직전 글. 되돌리기 한 단계만 갖는다. */
  const [prev, setPrev] = useState<{ subject: string; content: string } | null>(null);
  const busy = composing !== null;
  const empty = content.trim() === "";

  const run = (mode: ComposeMode): void => {
    setPrev({ subject, content });
    onCompose(mode);
  };

  const undo = (): void => {
    if (prev === null) return;
    onSubject(prev.subject);
    onContent(prev.content);
    setPrev(null);
  };

  return (
    <section style={{
      background: COLOR.surface, border: `1px solid ${COLOR.line}`,
      borderRadius: RADIUS.card, padding: "15px 20px 18px",
    }}>
      <div style={{
        display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 12,
      }}>
        <b style={{ fontSize: 14 }}>내용</b>
        <span style={{ fontSize: 12, color: COLOR.muted }}>
          한국어로 적었으면 <b style={{ fontWeight: 600 }}>번역</b>을,
          영어로 적었으면 <b style={{ fontWeight: 600 }}>정리</b>를 누르세요. 같은 칸에서 바뀝니다.
        </span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: COLOR.faint }}>
          {`${subject.length}/${subjectLimit}`}
        </span>
      </div>

      {/*
        글은 한 덩어리로 보여야 한다 — 제목과 본문이 따로 놀면 "등록될 글" 이 뭔지 흐려진다.
        편지 폭을 넘기면 읽기 어려워 가운데로 모아 둔다.
      */}
      <div style={{
        maxWidth: 880, margin: "0 auto",
        border: `1px solid ${empty ? COLOR.divider : COLOR.field}`,
        borderRadius: RADIUS.control, background: COLOR.surface,
        boxShadow: empty ? "none" : "0 1px 2px rgba(20,23,26,.05)",
        overflow: "hidden", opacity: busy ? 0.6 : 1,
        transition: "opacity 120ms ease",
      }}>
        <input
          value={subject} onChange={(e) => onSubject(e.target.value)}
          maxLength={subjectLimit} disabled={busy}
          placeholder="제목 — 정리하면 자동으로 채워집니다"
          style={{
            width: "100%", boxSizing: "border-box", padding: "12px 16px",
            fontSize: 13.5, fontWeight: 600, color: COLOR.ink, fontFamily: "inherit",
            background: "transparent", border: "none", outline: "none",
            borderBottom: `1px solid ${COLOR.divider}`,
          }}
        />
        <textarea
          value={content} onChange={(e) => onContent(e.target.value)}
          rows={14} disabled={busy}
          placeholder={"여기에 적으세요. 한국어로 적어도 됩니다.\n\n예) TPCF 10.4로 올린 뒤 OTel 콜렉터를 켜려고 합니다.\n    VM당 CPU·메모리가 얼마나 더 드는지,\n    지금 diego cell 12대에서 증설이 필요한지 알고 싶습니다."}
          style={{
            width: "100%", boxSizing: "border-box", padding: "14px 16px",
            fontSize: 13.5, lineHeight: 1.8, fontFamily: "inherit", color: COLOR.body,
            background: "transparent", border: "none", outline: "none", resize: "vertical",
          }}
        />
      </div>

      <div style={{
        maxWidth: 880, margin: "11px auto 0",
        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
      }}>
        <Action
          label={composing === "translate" ? "번역하는 중…" : "번역"}
          hint="한국어 → 영어 + 정리"
          primary disabled={busy || empty}
          onClick={() => run("translate")}
        />
        <Action
          label={composing === "tidy" ? "정리하는 중…" : "정리"}
          hint="영어 그대로 모양만"
          disabled={busy || empty}
          onClick={() => run("tidy")}
        />
        {prev !== null && !busy && (
          <button
            type="button" onClick={undo}
            style={{
              padding: 0, border: "none", background: "none", fontFamily: "inherit",
              fontSize: 12, color: COLOR.muted, cursor: "pointer", textDecoration: "underline",
            }}
          >
            되돌리기
          </button>
        )}
        {error !== "" && (
          <span style={{ fontSize: 12, color: COLOR.waitUs, lineHeight: 1.5 }}>{error}</span>
        )}
      </div>

      {/* 원문에 없어 Broadcom 이 되물을 법한 것들. 본문에는 (to be confirmed) 로 남아 있다. */}
      {gaps.length > 0 && (
        <div style={{
          maxWidth: 880, margin: "11px auto 0",
          background: COLOR.warnBg, border: `1px solid #f0d69a`,
          borderRadius: RADIUS.control, padding: "10px 13px",
          fontSize: 12, color: COLOR.warn, lineHeight: 1.65,
        }}>
          <b style={{ fontWeight: 600 }}>{`확인이 필요한 정보 ${gaps.length}건`}</b>
          <span style={{ opacity: 0.85 }}>{" — 채워 넣으면 한 번에 끝날 확률이 올라갑니다"}</span>
          <ul style={{ margin: "5px 0 0", paddingLeft: 17 }}>
            {gaps.map((g) => <li key={g}>{g}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}

function Action({
  label, hint, primary = false, disabled, onClick,
}: {
  label: string;
  hint: string;
  primary?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button" onClick={onClick} disabled={disabled} title={hint}
      style={{
        display: "inline-flex", alignItems: "baseline", gap: 7,
        padding: "9px 16px", fontFamily: "inherit", borderRadius: RADIUS.control,
        fontSize: 13, fontWeight: 600,
        border: `1px solid ${disabled ? COLOR.field : primary ? COLOR.accent : COLOR.field}`,
        background: disabled ? COLOR.ground : primary ? COLOR.accent : COLOR.surface,
        color: disabled ? COLOR.faint : primary ? "#ffffff" : COLOR.ink,
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {label}
      <span style={{
        fontSize: 11, fontWeight: 400,
        color: disabled ? COLOR.faint : primary ? "rgba(255,255,255,.75)" : COLOR.faint,
      }}>
        {hint}
      </span>
    </button>
  );
}
