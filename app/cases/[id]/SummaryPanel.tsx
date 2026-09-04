"use client";

import { useState } from "react";
import { COLOR, Card } from "../../ui.tsx";

type Kind = "confluence" | "report";

interface SummaryResponse {
  content?: string;
  source?: "draft" | "ai";
  generatedAt?: string;
  cached?: boolean;
  error?: string;
}

const KINDS: ReadonlyArray<{ id: Kind; label: string; note: string }> = [
  { id: "confluence", label: "Confluence 문서", note: "기술 상세 · 재발 시 검색용" },
  { id: "report", label: "정기 보고서", note: "요약 · 결과 중심" },
];

export function SummaryPanel({ requestId }: { requestId: number }) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [text, setText] = useState("");
  const [meta, setMeta] = useState<{ cached: boolean; at: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  async function load(next: Kind, force = false): Promise<void> {
    setKind(next);
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      const response = await fetch("/api/summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, kind: next, force }),
      });
      const data = (await response.json()) as SummaryResponse;
      if (data.error !== undefined || data.content === undefined) {
        setError(data.error ?? "정리본을 만들지 못했습니다.");
        setText("");
        setMeta(null);
        return;
      }
      setText(data.content);
      setMeta({ cached: data.cached === true, at: data.generatedAt ?? "" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Card style={{ padding: "16px 18px", marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <b style={{ fontSize: 14 }}>정리하기</b>
        <span style={{ fontSize: 12, color: COLOR.muted }}>용도를 고르면 문서를 만들어 둡니다</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {KINDS.map((k) => (
            <button
              key={k.id} type="button" title={k.note}
              onClick={() => void load(k.id)} disabled={busy}
              style={{
                padding: "7px 13px", fontSize: 13, fontWeight: kind === k.id ? 600 : 400,
                color: kind === k.id ? "#fff" : COLOR.ink,
                background: kind === k.id ? COLOR.accent : COLOR.surface,
                border: `1px solid ${kind === k.id ? COLOR.accent : COLOR.line}`,
                borderRadius: 8, cursor: busy ? "default" : "pointer", fontFamily: "inherit",
              }}
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>

      {error !== "" && (
        <div style={{
          background: COLOR.waitUsBg, color: COLOR.waitUs, borderRadius: 8,
          padding: "10px 14px", marginTop: 14, fontSize: 13,
        }}>
          {error}
        </div>
      )}

      {kind !== null && error === "" && (
        <>
          <div style={{
            display: "flex", alignItems: "center", gap: 10,
            margin: "14px 0 8px", fontSize: 12, color: COLOR.muted,
          }}>
            <span>{KINDS.find((k) => k.id === kind)?.note}</span>
            {meta !== null && (
              <span>{meta.cached ? "저장된 문서" : "새로 만듦"}
                {meta.at !== "" && ` · ${new Date(meta.at).toLocaleString("ko-KR")}`}
              </span>
            )}
            <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button
                type="button" onClick={() => void load(kind, true)} disabled={busy}
                style={chipStyle}
              >
                다시 만들기
              </button>
              <button type="button" onClick={copy} disabled={busy || text === ""} style={chipStyle}>
                {copied ? "복사됨" : "복사"}
              </button>
            </span>
          </div>

          <textarea
            readOnly value={busy ? "만드는 중…" : text} rows={16}
            style={{
              width: "100%", boxSizing: "border-box", padding: "12px 14px",
              fontSize: 13, lineHeight: 1.7, fontFamily: "ui-monospace, Consolas, monospace",
              border: `1px solid ${COLOR.line}`, borderRadius: 8, background: COLOR.ground,
              resize: "vertical",
            }}
          />

          <p style={{ fontSize: 12, color: COLOR.muted, margin: "10px 0 0", lineHeight: 1.6 }}>
            한 번 만든 문서는 저장해 두고 다음부터는 그대로 불러옵니다.
            지금은 수집 내용을 형식에 맞춰 엮은 초안이고, 문장 다듬기는 AI 연동을 붙이면
            <b> 다시 만들기</b> 로 갱신됩니다.
          </p>
        </>
      )}
    </Card>
  );
}

const chipStyle = {
  padding: "5px 11px", fontSize: 12, border: `1px solid ${COLOR.line}`,
  borderRadius: 6, background: COLOR.surface, cursor: "pointer",
  fontFamily: "inherit" as const,
};
