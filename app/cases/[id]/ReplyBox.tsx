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
            value={text} onChange={(e) => setText(e.target.value)} rows={7} disabled={busy}
            placeholder="Broadcom 담당자에게 보낼 내용을 적으세요. 영문으로 쓰시는 것이 좋습니다."
            style={{
              width: "100%", boxSizing: "border-box", padding: "11px 13px",
              fontSize: 13.5, lineHeight: 1.7, color: COLOR.ink,
              border: `1px solid ${COLOR.field}`, borderRadius: RADIUS.control,
              fontFamily: "inherit", outline: "none", resize: "vertical",
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
            <span style={{ fontSize: 11.5, color: COLOR.faint, lineHeight: 1.5 }}>
              전송하면 Broadcom 케이스에 바로 올라가고 되돌릴 수 없습니다.
            </span>
            <button
              type="button" onClick={() => setStage("confirm")} disabled={!ready}
              style={{
                ...controlStyle, marginLeft: "auto", padding: "8px 16px", fontWeight: 600,
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
