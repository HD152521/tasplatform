"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { COLOR, Card, RADIUS, controlStyle } from "../../ui.tsx";

/**
 * 답변 작성란.
 *
 * 이 버튼이 실제로 Broadcom 케이스에 글을 올린다. 되돌릴 수 없고 담당 엔지니어가
 * 바로 읽으므로, 보내기 전에 무엇이 올라가는지 한 번 더 보여주고 확인을 받는다.
 */
export function ReplyBox({ requestId, caseLabel }: { requestId: number; caseLabel: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [stage, setStage] = useState<"write" | "confirm">("write");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  /** 돌고 있는 변환. 없으면 null. */
  const [composing, setComposing] = useState<"translate" | "tidy" | null>(null);
  /** 변환 직전 글. 되돌리기 한 단계만 갖는다. */
  const [prev, setPrev] = useState<string | null>(null);

  /**
   * 적은 글을 Broadcom 에 보낼 영문으로 바꾼다. 그 자리에서 갈아끼우므로
   * 직전 글을 들고 있다가 되돌릴 수 있게 한다.
   */
  async function compose(mode: "translate" | "tidy"): Promise<void> {
    setComposing(mode);
    setError("");
    const before = text;
    try {
      const response = await fetch("/api/reply/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text, mode, requestId }),
      });
      const data = (await response.json()) as { ok?: boolean; message?: string; content?: string };
      if (data.ok !== true || typeof data.content !== "string") {
        setError(data.message ?? `변환에 실패했습니다 (HTTP ${response.status}).`);
        return;
      }
      setPrev(before);
      setText(data.content);
    } catch (e) {
      setError(e instanceof Error ? e.message : "변환 중 오류가 발생했습니다.");
    } finally {
      setComposing(null);
    }
  }

  const ready = text.trim() !== "";

  async function send(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, text }),
      });
      const data = (await response.json()) as { ok?: boolean; message?: string };
      if (data.ok === true) {
        setDone(data.message ?? "답변을 등록했습니다.");
        setText("");
        setStage("write");
        router.refresh();
        return;
      }
      setError(data.message ?? "전송에 실패했습니다.");
      setStage("write");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("write");
    } finally {
      setBusy(false);
    }
  }

  if (done !== "") {
    return (
      <Card style={{
        padding: "16px 18px", background: COLOR.okBg, borderColor: "#b9e6cd",
        color: COLOR.ok, fontSize: 13.5, lineHeight: 1.7,
      }}>
        <b>{done}</b>
        <div style={{ marginTop: 4, opacity: 0.9 }}>
          다음 수집 때 이 대화에 반영됩니다.
        </div>
        <button type="button" onClick={() => setDone("")} style={{
          ...controlStyle, marginTop: 12, padding: "6px 12px", fontSize: 12,
        }}>
          답변 더 쓰기
        </button>
      </Card>
    );
  }

  return (
    <Card style={{ padding: "16px 18px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 11 }}>
        <span style={{
          width: 26, height: 26, borderRadius: 7, fontSize: 10, fontWeight: 600,
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "#4b5563", background: "#eef1f6",
        }}>
          우리
        </span>
        <b style={{ fontSize: 13 }}>답변 쓰기</b>
        <span style={{ fontSize: 11, color: COLOR.faint }}>{caseLabel}</span>
      </div>

      {error !== "" && (
        <div style={{
          background: COLOR.waitUsBg, color: COLOR.waitUs, border: `1px solid #f3c7c2`,
          borderRadius: RADIUS.control, padding: "10px 13px", marginBottom: 11,
          fontSize: 12.5, lineHeight: 1.6,
        }}>
          {error}
        </div>
      )}

      {stage === "write" ? (
        <>
          <textarea
            value={text} onChange={(e) => setText(e.target.value)} rows={7}
            disabled={busy || composing !== null}
            placeholder="한국어로 적어도 됩니다. 아래 번역 버튼이 영문으로 바꿔 줍니다."
            style={{
              width: "100%", boxSizing: "border-box", padding: "11px 13px",
              fontSize: 13.5, lineHeight: 1.7, color: COLOR.ink,
              border: `1px solid ${COLOR.field}`, borderRadius: RADIUS.control,
              fontFamily: "inherit", outline: "none", resize: "vertical",
            }}
          />
          <div style={{
            display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap",
          }}>
            {/* 한국어로 적고 보내기 전에 영문으로 바꾼다. 전송 바로 옆에 둔다. */}
            <Convert
              label={composing === "translate" ? "번역 중…" : "번역"}
              hint="한국어 → 영어"
              disabled={!ready || composing !== null}
              onClick={() => void compose("translate")}
            />
            <Convert
              label={composing === "tidy" ? "정리 중…" : "정리"}
              hint="영어 그대로 다듬기"
              disabled={!ready || composing !== null}
              onClick={() => void compose("tidy")}
            />
            {prev !== null && composing === null && (
              <button
                type="button" onClick={() => { setText(prev); setPrev(null); }}
                style={{
                  padding: 0, border: "none", background: "none", fontFamily: "inherit",
                  fontSize: 11.5, color: COLOR.muted, cursor: "pointer", textDecoration: "underline",
                }}
              >
                되돌리기
              </button>
            )}
            <span style={{
              marginLeft: "auto", fontSize: 11.5, color: COLOR.faint, lineHeight: 1.5,
            }}>
              전송하면 바로 올라가고 되돌릴 수 없습니다.
            </span>
            <button
              type="button" onClick={() => setStage("confirm")} disabled={!ready || composing !== null}
              style={{
                ...controlStyle, padding: "8px 16px", fontWeight: 600,
                color: ready ? "#ffffff" : COLOR.faint,
                background: ready ? COLOR.accent : COLOR.ground,
                borderColor: ready ? COLOR.accent : COLOR.field,
                cursor: ready ? "pointer" : "default",
              }}
            >
              전송
            </button>
          </div>
        </>
      ) : (
        <>
          <div style={{
            fontSize: 12, color: COLOR.warn, background: COLOR.warnBg,
            border: "1px solid #f0d69a", borderRadius: RADIUS.control,
            padding: "10px 13px", marginBottom: 11, lineHeight: 1.6,
          }}>
            아래 내용이 <b>{caseLabel}</b> 케이스에 등록됩니다. 담당 엔지니어가 바로 읽습니다.
          </div>

          <pre style={{
            margin: 0, padding: "12px 14px", fontSize: 13, lineHeight: 1.75,
            color: COLOR.body, background: COLOR.ground, borderRadius: RADIUS.control,
            whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit",
            maxHeight: 260, overflow: "auto",
          }}>
            {text}
          </pre>

          <div style={{ display: "flex", gap: 8, marginTop: 11 }}>
            <button
              type="button" onClick={() => setStage("write")} disabled={busy}
              style={{ ...controlStyle, padding: "8px 14px" }}
            >
              고치기
            </button>
            <button
              type="button" onClick={send} disabled={busy}
              style={{
                ...controlStyle, marginLeft: "auto", padding: "8px 18px", fontWeight: 600,
                color: "#ffffff",
                background: busy ? COLOR.muted : COLOR.waitUs,
                borderColor: busy ? COLOR.muted : COLOR.waitUs,
                cursor: busy ? "default" : "pointer",
              }}
            >
              {busy ? "전송 중…" : "확인, 전송합니다"}
            </button>
          </div>
        </>
      )}
    </Card>
  );
}

/** 전송 옆에 붙는 작은 변환 버튼. 무엇을 하는지 한 줄로 달아 둔다. */
function Convert({
  label, hint, disabled, onClick,
}: { label: string; hint: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button" onClick={onClick} disabled={disabled} title={hint}
      style={{
        display: "inline-flex", alignItems: "baseline", gap: 6,
        padding: "7px 12px", fontSize: 12.5, fontWeight: 600, fontFamily: "inherit",
        color: disabled ? COLOR.faint : COLOR.ink,
        background: disabled ? COLOR.ground : COLOR.surface,
        border: `1px solid ${COLOR.field}`, borderRadius: RADIUS.control,
        cursor: disabled ? "default" : "pointer", whiteSpace: "nowrap",
      }}
    >
      {label}
      <span style={{ fontSize: 10.5, fontWeight: 400, color: COLOR.faint }}>{hint}</span>
    </button>
  );
}
