"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  TARGET_CORPS,
  TARGET_ENVS,
  TARGET_PLACEHOLDER,
  buildTargetLabel,
} from "../../../lib/summaryTarget.ts";
import { COLOR, Card, MONO_STACK } from "../../ui.tsx";

type Kind = "confluence";

interface SummaryResponse {
  content?: string;
  source?: "draft" | "ai";
  generatedAt?: string;
  cached?: boolean;
  error?: string;
}

const KINDS: ReadonlyArray<{ id: Kind; label: string; note: string }> = [
  { id: "confluence", label: "Confluence 문서", note: "SR 현행화 양식" },
];

/** 태그 한 묶음. 앞에 무엇을 고르는 줄인지 적는다. */
function TagGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "4px 5px 4px 10px", borderRadius: 999, background: COLOR.ground,
    }}>
      <span style={{ fontSize: 11, color: COLOR.faint, whiteSpace: "nowrap" }}>{label}</span>
      {children}
    </span>
  );
}

/** 고른 것을 켜고 끄는 토글. 하나 고를 때마다 대상 환경 표기가 바뀐다. */
function Tag({
  label, on, disabled, onClick,
}: { label: string; on: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button" onClick={onClick} disabled={disabled} aria-pressed={on}
      style={{
        padding: "4px 11px", fontSize: 12.5, fontFamily: "inherit",
        fontWeight: on ? 600 : 400,
        color: on ? "#ffffff" : COLOR.body,
        background: on ? COLOR.accent : COLOR.surface,
        border: `1px solid ${on ? COLOR.accent : COLOR.field}`,
        borderRadius: 999, cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {label}
    </button>
  );
}

export function SummaryPanel({ requestId }: { requestId: number }) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [text, setText] = useState("");
  const [meta, setMeta] = useState<{ cached: boolean; at: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<{ url: string; created: boolean } | null>(null);
  // 법인과 환경을 따로 고른다. 둘 다 여러 개 고를 수 있다.
  const [corps, setCorps] = useState<readonly string[]>([]);
  const [envs, setEnvs] = useState<readonly string[]>([]);
  const target = useMemo(() => buildTargetLabel(corps, envs), [corps, envs]);

  /** 있으면 빼고 없으면 넣는다. 순서는 표기를 만들 때 선언 순서로 정리된다. */
  const toggle = (
    set: (next: readonly string[]) => void,
    current: readonly string[],
    value: string,
  ): void => {
    set(current.includes(value) ? current.filter((v) => v !== value) : [...current, value]);
  };

  async function load(next: Kind, force = false): Promise<void> {
    setKind(next);
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      const response = await fetch("/api/summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, kind: next, force, target }),
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

  async function publish(): Promise<void> {
    setPublishing(true);
    setError("");
    setPublished(null);
    try {
      const response = await fetch("/api/summary/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
      });
      const data = (await response.json()) as {
        ok?: boolean; url?: string; created?: boolean; error?: string;
      };
      if (data.ok !== true || data.url === undefined) {
        setError(data.error ?? "Confluence 업로드에 실패했습니다.");
        return;
      }
      setPublished({ url: data.url, created: data.created === true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPublishing(false);
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

      {/*
        대상 환경. 법인과 환경을 따로, 여러 개 고를 수 있다.
        예전엔 미리 조합해 둔 선택지 일곱 개짜리 select 였는데, 조합이 늘면 감당이 안 되고
        DR·AWS 는 아예 고를 수가 없었다.
      */}
      <div style={{ marginTop: 14 }}>
        <div style={{
          display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap",
          fontSize: 12.5, color: COLOR.muted, marginBottom: 8,
        }}>
          <span>대상 환경 <span style={{ color: COLOR.faint }}>(선택)</span></span>
          <span style={{
            fontFamily: MONO_STACK, fontSize: 12,
            color: target === "" ? COLOR.faint : COLOR.ink,
            fontWeight: target === "" ? 400 : 600,
          }}>
            {target === "" ? TARGET_PLACEHOLDER : target}
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <TagGroup label="법인">
            {TARGET_CORPS.map((c) => (
              <Tag
                key={c.id} label={c.label} on={corps.includes(c.id)} disabled={busy}
                onClick={() => toggle(setCorps, corps, c.id)}
              />
            ))}
          </TagGroup>
          <TagGroup label="환경">
            {TARGET_ENVS.map((e) => (
              <Tag
                key={e} label={e} on={envs.includes(e)} disabled={busy}
                onClick={() => toggle(setEnvs, envs, e)}
              />
            ))}
          </TagGroup>
          {target !== "" && (
            <button
              type="button" disabled={busy}
              onClick={() => { setCorps([]); setEnvs([]); }}
              style={{
                padding: 0, border: "none", background: "none", fontFamily: "inherit",
                fontSize: 11.5, color: COLOR.faint, cursor: busy ? "default" : "pointer",
              }}
            >
              지우기
            </button>
          )}
        </div>

        <p style={{ margin: "9px 0 0", fontSize: 11.5, color: COLOR.faint }}>
          고른 뒤 <b>다시 만들기</b>를 눌러야 표에 반영됩니다. 안 고르면 {TARGET_PLACEHOLDER} 로 남습니다.
        </p>
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
              <button
                type="button" onClick={() => void publish()}
                disabled={busy || publishing || text === ""} style={chipStyle}
              >
                {publishing ? "올리는 중…" : "Confluence에 올리기"}
              </button>
            </span>
          </div>

          {published !== null && (
            <div style={{
              background: COLOR.ground, border: `1px solid ${COLOR.line}`, borderRadius: 8,
              padding: "9px 13px", marginTop: 10, fontSize: 12.5,
            }}>
              {published.created ? "새 문서로 올렸습니다" : "기존 문서를 갱신했습니다"} ·{" "}
              <a href={published.url} target="_blank" rel="noreferrer" style={{ color: COLOR.accent }}>
                Confluence에서 열기 ↗
              </a>
            </div>
          )}

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
