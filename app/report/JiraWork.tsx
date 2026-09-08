"use client";

import { useState } from "react";
import { COLOR, Card, MONO_STACK, Notice, RADIUS, controlStyle } from "../ui.tsx";

interface WorkRow {
  key: string;
  url: string;
  center: string;
  corp: string;
  span: string;
  title: string;
  support: string;
  issue: string;
  note: string;
}

interface SkippedRow {
  key: string;
  title: string;
  reason: string;
}

/**
 * 3-3 작업 진행 현황.
 *
 * Jira 를 읽어 표를 만든다. 아직 쓰기는 하지 않는다 — 조회 결과를 눈으로 확인하는 단계다.
 * 제외된 건도 사유와 함께 보여준다. 조용히 빠지면 왜 없는지 알 수 없다.
 */
export function JiraWork({ month, initial }: { month: string; initial: string[] }) {
  const [rows, setRows] = useState<WorkRow[] | null>(null);
  const [skipped, setSkipped] = useState<SkippedRow[]>([]);
  const [scanned, setScanned] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [showSkipped, setShowSkipped] = useState(false);

  async function load(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/report/jira?month=${month}`);
      const body = (await response.json()) as {
        ok?: boolean; message?: string;
        rows?: WorkRow[]; skipped?: SkippedRow[]; scanned?: number;
      };
      if (!response.ok || body.ok !== true) {
        setError(body.message ?? `조회에 실패했습니다 (HTTP ${response.status}).`);
        setRows(null);
        return;
      }
      const got = body.rows ?? [];
      setRows(got);
      setSkipped(body.skipped ?? []);
      setScanned(body.scanned ?? 0);
      // 저장된 선택이 있으면 그대로, 없으면 전부 포함으로 시작한다.
      const known = new Set(got.map((r) => r.key));
      setPicked(initial.length > 0
        ? new Set(initial.filter((k) => known.has(k)))
        : known);
    } catch (e) {
      setError(e instanceof Error ? e.message : "조회 중 오류가 발생했습니다.");
      setRows(null);
    } finally {
      setBusy(false);
    }
  }

  function toggle(key: string): void {
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    setSaved(false);
  }

  async function save(): Promise<void> {
    if (rows === null) return;
    setSaving(true);
    setError("");
    try {
      const refs = rows.map((r) => r.key).filter((k) => picked.has(k));
      const response = await fetch("/api/report/picks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, kind: "jira", refs }),
      });
      const body = (await response.json()) as { ok?: boolean; message?: string };
      if (!response.ok || body.ok !== true) {
        setError(body.message ?? `저장에 실패했습니다 (HTTP ${response.status}).`);
        return;
      }
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 중 오류가 발생했습니다.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card style={{ padding: "18px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <div style={{
          fontSize: 11, fontWeight: 600, color: COLOR.faint, letterSpacing: "0.04em",
        }}>
          3-3 작업 진행 현황
        </div>
        {rows !== null && (
          <span style={{ fontSize: 11.5, color: COLOR.muted }}>
            {`Jira ${scanned}건 조회 · 채택 ${rows.length} · 선택 ${picked.size}`}
          </span>
        )}
        <button
          type="button" onClick={() => void load()} disabled={busy}
          style={{ ...controlStyle, marginLeft: "auto", padding: "6px 13px", fontSize: 12.5 }}
        >
          {busy ? "불러오는 중…" : rows === null ? "Jira 에서 불러오기" : "다시 불러오기"}
        </button>
        {rows !== null && rows.length > 0 && (
          <button
            type="button" onClick={() => void save()} disabled={saving}
            style={{
              padding: "6px 14px", fontSize: 12.5, fontWeight: 600,
              color: "#ffffff", background: COLOR.accent,
              border: `1px solid ${COLOR.accent}`, borderRadius: 8,
              cursor: saving ? "default" : "pointer", fontFamily: "inherit",
            }}
          >
            {saving ? "저장 중…" : "선택 저장"}
          </button>
        )}
      </div>

      {saved && error === "" && (
        <div style={{ marginTop: 12 }}>
          <Notice tone="ok">{`${picked.size}건을 보고서에 넣도록 저장했습니다.`}</Notice>
        </div>
      )}

      {error !== "" && <div style={{ marginTop: 12 }}><Notice tone="error">{error}</Notice></div>}

      {rows !== null && rows.length === 0 && error === "" && (
        <p style={{ margin: "14px 0 0", fontSize: 13, color: COLOR.muted }}>
          {`${month.replace("-", "년 ")}월에 해당하는 은행·중앙회 작업이 없습니다.`}
        </p>
      )}

      {rows !== null && rows.length > 0 && (
        <>
          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr>
                  <th style={{ ...th, width: 34 }} />
                  {["전산센터", "법인", "작업일", "지원유형", "작업 내역", "이슈 사항", "비고"]
                    .map((h) => <th key={h} style={th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const on = picked.has(r.key);
                  return (
                    <tr key={r.key} style={{ opacity: on ? 1 : 0.4 }}>
                      <td style={td}>
                        <input type="checkbox" checked={on} onChange={() => toggle(r.key)} />
                      </td>
                      <td style={td}>{r.center === "" ? "-" : r.center}</td>
                      <td style={td}>{r.corp}</td>
                      <td style={{ ...td, fontFamily: MONO_STACK, whiteSpace: "nowrap" }}>{r.span}</td>
                      <td style={td}>{r.support}</td>
                      <td style={td}>
                        <a href={r.url} target="_blank" rel="noreferrer"
                           style={{ color: COLOR.ink, textDecoration: "none" }}>
                          {r.title}
                          <span style={{
                            marginLeft: 7, fontFamily: MONO_STACK, fontSize: 10.5, color: COLOR.faint,
                          }}>
                            {r.key}
                          </span>
                        </a>
                      </td>
                      <td style={{ ...td, color: COLOR.muted }}>{r.issue}</td>
                      <td style={td}>{r.note}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {skipped.length > 0 && (
            <div style={{ marginTop: 13 }}>
              <button
                type="button" onClick={() => setShowSkipped((v) => !v)}
                style={{
                  background: "none", border: "none", padding: 0, cursor: "pointer",
                  fontSize: 12, color: COLOR.accent, fontFamily: "inherit",
                }}
              >
                {showSkipped ? "▾" : "▸"} {`보고서에서 뺀 ${skipped.length}건`}
              </button>
              {showSkipped && (
                <div style={{
                  marginTop: 9, padding: "11px 13px", background: COLOR.ground,
                  borderRadius: RADIUS.control, display: "flex",
                  flexDirection: "column", gap: 5,
                }}>
                  {skipped.map((s) => (
                    <div key={s.key} style={{ display: "flex", gap: 10, fontSize: 11.5 }}>
                      <span style={{ fontFamily: MONO_STACK, color: COLOR.faint, width: 88 }}>
                        {s.key}
                      </span>
                      <span style={{ color: COLOR.body, flex: 1 }}>{s.title}</span>
                      <span style={{ color: COLOR.muted }}>{s.reason}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

const th: React.CSSProperties = {
  padding: "8px 10px", textAlign: "left", fontWeight: 600, fontSize: 11.5,
  color: COLOR.faint, borderBottom: `1px solid ${COLOR.line}`, whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  padding: "9px 10px", borderBottom: `1px solid ${COLOR.divider}`, color: COLOR.body,
};
