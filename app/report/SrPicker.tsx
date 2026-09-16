"use client";

import { useMemo, useState } from "react";
import type { MonthCaseRow } from "../../lib/queries.ts";
import { Badge, COLOR, Card, MONO_STACK, Notice, statusColors } from "../ui.tsx";

/**
 * 2단계 · SR 선택.
 *
 * 그 달에 등록된 케이스를 전부 보여주고, 보고서에 넣을 것만 고른다.
 * 실제 8월 보고서를 보면 11건 중 6건만 실렸다 — 전부 넣지는 않는다.
 *
 * 컬럼은 보고서의 "01 SR 진행현황 요약" 표와 같은 순서로 뒀다.
 */

/** 마지막 답변에서 한 줄만. 표에 넣을 길이로 자른다. */
function brief(text: string, max = 92): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return "";
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function shortDate(iso: string): string {
  return iso.slice(0, 10);
}

export function SrPicker({
  month, cases, initial,
}: {
  month: string;
  cases: MonthCaseRow[];
  initial: string[];
}) {
  // 저장된 선택이 있으면 그걸로, 없으면 전부 선택으로 시작한다.
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(initial.length > 0 ? initial : cases.map((c) => String(c.request_id))),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const order = useMemo(
    () => cases.map((c) => String(c.request_id)).filter((id) => picked.has(id)),
    [cases, picked],
  );

  function toggle(id: string): void {
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setSaved(false);
  }

  function toggleAll(): void {
    setPicked((cur) =>
      cur.size === cases.length ? new Set() : new Set(cases.map((c) => String(c.request_id))));
    setSaved(false);
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/report/picks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, kind: "sr", refs: order }),
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
      setBusy(false);
    }
  }

  if (cases.length === 0) {
    return (
      <Card style={{ padding: 40, textAlign: "center", color: COLOR.faint, fontSize: 13 }}>
        {`${month.replace("-", "년 ")}월에 등록된 SR 이 없습니다.`}
        <div style={{ marginTop: 8, fontSize: 12 }}>
          수집이 되어 있는지 확인해 주세요.
        </div>
      </Card>
    );
  }

  return (
    <>
      {error !== "" && <Notice tone="error">{error}</Notice>}
      {saved && error === "" && (
        <Notice tone="ok">{`${picked.size}건을 보고서에 넣도록 저장했습니다.`}</Notice>
      )}

      <Card style={{ padding: "16px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: COLOR.faint, letterSpacing: "0.04em",
          }}>
            01 SR 진행현황 요약
          </div>
          <span style={{ fontSize: 11.5, color: COLOR.muted }}>
            {`${cases.length}건 중 ${picked.size}건 선택`}
          </span>
          <button type="button" onClick={toggleAll} style={ghost}>
            {picked.size === cases.length ? "전체 해제" : "전체 선택"}
          </button>
          <button
            type="button" onClick={() => void save()} disabled={busy}
            style={{
              marginLeft: "auto", padding: "7px 15px", fontSize: 12.5, fontWeight: 600,
              color: "#ffffff", background: COLOR.accent,
              border: `1px solid ${COLOR.accent}`, borderRadius: 8,
              cursor: busy ? "default" : "pointer", fontFamily: "inherit",
            }}
          >
            {busy ? "저장 중…" : "선택 저장"}
          </button>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 34 }} />
                {["SR No.", "발생일", "SR 내용", "진행 현황", "완료여부"].map((h) => (
                  <th key={h} style={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => {
                const id = String(c.request_id);
                const on = picked.has(id);
                const tone = statusColors(c.status);
                return (
                  <tr key={id} style={{ opacity: on ? 1 : 0.4 }}>
                    <td style={td}>
                      <input type="checkbox" checked={on} onChange={() => toggle(id)} />
                    </td>
                    <td style={{ ...td, fontFamily: MONO_STACK, whiteSpace: "nowrap" }}>
                      <a href={`/cases/${c.request_id}`} target="_blank" rel="noreferrer"
                         style={{ color: COLOR.accent, textDecoration: "none" }}>
                        {c.request_id_formatted}
                      </a>
                    </td>
                    <td style={{ ...td, fontFamily: MONO_STACK, whiteSpace: "nowrap" }}>
                      {shortDate(c.created_on)}
                    </td>
                    <td style={{ ...td, maxWidth: 330 }}>{c.subject}</td>
                    <td style={{ ...td, maxWidth: 340, color: COLOR.muted, fontSize: 11.5 }}>
                      {brief(c.last_reply) || (
                        <span style={{ color: COLOR.faint }}>(Broadcom 답변 없음)</span>
                      )}
                    </td>
                    <td style={td}>
                      <Badge fg={tone.fg} bg={tone.bg}>{c.status}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p style={{ margin: "13px 0 0", fontSize: 11.5, color: COLOR.faint, lineHeight: 1.6 }}>
          고른 SR 은 요약 표에 한 줄씩, 그리고 상세 페이지에 한 장씩 들어갑니다.
          진행 현황 문구는 마지막 Broadcom 답변에서 가져온 것이라 다듬어야 합니다.
        </p>
      </Card>
    </>
  );
}

const th: React.CSSProperties = {
  padding: "8px 10px", textAlign: "left", fontWeight: 600, fontSize: 11.5,
  color: COLOR.faint, borderBottom: `1px solid ${COLOR.line}`, whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  padding: "9px 10px", borderBottom: `1px solid ${COLOR.divider}`,
  color: COLOR.body, verticalAlign: "top",
};
const ghost: React.CSSProperties = {
  padding: "5px 11px", fontSize: 11.5, color: COLOR.body,
  background: COLOR.surface, border: `1px solid ${COLOR.field}`,
  borderRadius: 8, cursor: "pointer", fontFamily: "inherit",
};
