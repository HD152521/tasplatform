"use client";

/**
 * 한국어 초안 → Broadcom 에 보낼 영문.
 *
 * 예전에는 케이스 속성 카드(좁은 왼쪽 칸) 안에 두 칸을 욱여넣어, 한 칸이 270px 남짓이라
 * 영문을 읽을 수가 없었다. 화면 전체 폭을 쓰는 작업대로 빼낸다.
 *
 * 두 칸의 **재질을 다르게** 둔 것이 이 화면의 요점이다.
 *   왼쪽 : 바탕색 위의 글 쓰는 자리. 임시 메모다.
 *   오른쪽: 흰 종이에 제목과 본문이 올라간 문서. **이게 실제로 등록되는 글이다.**
 * 그래서 오른쪽만 테두리와 그림자를 갖고, 제목 줄과 본문 사이에 구분선이 있다.
 */
import { COLOR, MONO_STACK, RADIUS } from "../ui.tsx";

export function Composer({
  korean, onKorean,
  subject, onSubject, subjectLimit,
  content, onContent,
  onCompose, composing, error, gaps,
}: {
  korean: string;
  onKorean: (v: string) => void;
  subject: string;
  onSubject: (v: string) => void;
  subjectLimit: number;
  content: string;
  onContent: (v: string) => void;
  onCompose: () => void;
  composing: boolean;
  error: string;
  /** 원문에 없어 담당자가 채워야 할 것들. */
  gaps: readonly string[];
}) {
  const ready = korean.trim() !== "";
  const filled = content.trim() !== "";

  return (
    <section style={{
      background: COLOR.surface, border: `1px solid ${COLOR.line}`,
      borderRadius: RADIUS.card, overflow: "hidden",
    }}>
      <div style={{
        display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap",
        padding: "15px 20px", borderBottom: `1px solid ${COLOR.divider}`,
      }}>
        <b style={{ fontSize: 14 }}>내용</b>
        <span style={{ fontSize: 12, color: COLOR.muted }}>
          한국어로 적고 영문으로 정리합니다. 등록되는 것은 오른쪽 글입니다.
        </span>
      </div>

      {/* 두 칸. 좁아지면 위아래로 접힌다. */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
        gap: 0, alignItems: "stretch",
      }}>
        {/* ── 왼쪽: 초안 ── */}
        <div style={{
          padding: "16px 20px 18px", background: COLOR.ground,
          borderRight: `1px solid ${COLOR.divider}`,
          display: "flex", flexDirection: "column", gap: 10,
        }}>
          <PaneTitle>한국어 초안</PaneTitle>
          <textarea
            value={korean} onChange={(e) => onKorean(e.target.value)} rows={16}
            placeholder={"TPCF 10.4로 올린 뒤 OTel 콜렉터를 켜려고 합니다.\n\nVM당 CPU·메모리가 얼마나 더 드는지,\n지금 diego cell 12대에서 증설이 필요한지 알고 싶습니다."}
            style={{
              width: "100%", boxSizing: "border-box", padding: "13px 15px",
              fontSize: 13.5, lineHeight: 1.8, fontFamily: "inherit", color: COLOR.ink,
              background: COLOR.surface, border: `1px solid ${COLOR.field}`,
              borderRadius: RADIUS.control, outline: "none", resize: "vertical", flex: 1,
            }}
          />

          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button" onClick={onCompose} disabled={composing || !ready}
              style={{
                padding: "9px 17px", fontSize: 13, fontWeight: 600, fontFamily: "inherit",
                borderRadius: RADIUS.control,
                border: `1px solid ${ready ? COLOR.accent : COLOR.field}`,
                background: ready ? COLOR.accent : COLOR.surface,
                color: ready ? "#ffffff" : COLOR.faint,
                cursor: composing || !ready ? "default" : "pointer",
                opacity: composing ? 0.75 : 1,
              }}
            >
              {composing ? "정리하는 중…" : filled ? "다시 정리 →" : "영문으로 정리 →"}
            </button>
            {error !== "" && (
              <span style={{ fontSize: 12, color: COLOR.waitUs, lineHeight: 1.5 }}>{error}</span>
            )}
          </div>
        </div>

        {/* ── 오른쪽: 등록될 글 ── */}
        <div style={{ padding: "16px 20px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <PaneTitle>Broadcom 에 보낼 글</PaneTitle>
            <span style={{ marginLeft: "auto", fontSize: 11, color: COLOR.faint }}>
              {`${subject.length}/${subjectLimit}`}
            </span>
          </div>

          <div style={{
            flex: 1, display: "flex", flexDirection: "column",
            border: `1px solid ${filled ? COLOR.field : COLOR.divider}`,
            borderRadius: RADIUS.control, background: COLOR.surface,
            boxShadow: filled ? "0 1px 2px rgba(20,23,26,.05)" : "none",
            overflow: "hidden",
          }}>
            <input
              value={subject} onChange={(e) => onSubject(e.target.value)} maxLength={subjectLimit}
              placeholder="[TPCF 10.4] Resource sizing inquiry for enabling OpenTelemetry"
              style={{
                width: "100%", boxSizing: "border-box", padding: "12px 15px",
                fontSize: 13.5, fontWeight: 600, color: COLOR.ink, fontFamily: "inherit",
                background: "transparent", border: "none", outline: "none",
                borderBottom: `1px solid ${COLOR.divider}`,
              }}
            />
            <textarea
              value={content} onChange={(e) => onContent(e.target.value)} rows={14}
              placeholder={"Hello Support Team,\n\n왼쪽에 적고 '영문으로 정리' 를 누르면\n여기에 채워집니다. 그대로 고쳐 쓸 수 있습니다.\n\nQuestions\n1. …\n\nThanks,"}
              style={{
                width: "100%", boxSizing: "border-box", padding: "13px 15px",
                fontSize: 12.5, lineHeight: 1.8, fontFamily: MONO_STACK, color: COLOR.body,
                background: "transparent", border: "none", outline: "none",
                resize: "vertical", flex: 1,
              }}
            />
          </div>

          {/* 원문에 없어 Broadcom 이 되물을 법한 것들. 본문에는 (to be confirmed) 로 남아 있다. */}
          {gaps.length > 0 ? (
            <div style={{
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
          ) : (
            <p style={{ margin: 0, fontSize: 11.5, color: COLOR.faint, lineHeight: 1.6 }}>
              {filled
                ? "정리했습니다. 내용을 확인하고 오른쪽 위 SR 등록을 누르세요."
                : "제목과 본문은 정리 후에도 직접 고칠 수 있습니다."}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function PaneTitle({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, color: COLOR.faint, letterSpacing: "0.04em",
    }}>
      {children}
    </span>
  );
}
