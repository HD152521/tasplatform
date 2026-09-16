"use client";

import { Fragment, useMemo, useState } from "react";
import {
  calculateInstances,
  type InstanceInput,
  type PreviousMonth,
} from "../../lib/instanceCount.ts";
import { COLOR, Card, MONO_STACK, Notice, RADIUS, controlStyle } from "../ui.tsx";

const EMPTY: InstanceInput = {
  bank: { dev: 0, prod: 0, dr: 0 },
  central: { dev: 0, prod: 0, dr: 0 },
  shared: { dev: 0, prod: 0, dr: 0 },
};

type Group = keyof InstanceInput;
type Env = keyof InstanceInput["bank"];

const GROUPS: ReadonlyArray<{ key: Group; label: string; note: string }> = [
  { key: "bank", label: "은행", note: "App Count" },
  { key: "central", label: "중앙회", note: "App Count" },
  { key: "shared", label: "공동 ORG", note: "은행·중앙회가 나눠 씀" },
];

const ENVS: ReadonlyArray<{ key: Env; label: string }> = [
  { key: "dev", label: "개발" },
  { key: "prod", label: "운영" },
  { key: "dr", label: "DR" },
];

/** 전월 인스턴스 6칸. 결과 표의 여섯 행과 같은 순서다. */
const PREV_FIELDS: ReadonlyArray<{ key: keyof PreviousMonth; label: string }> = [
  { key: "bankProd", label: "은행 운영" },
  { key: "bankProdShared", label: "은행 운영(공통)" },
  { key: "bankDev", label: "은행 개발" },
  { key: "bankDevShared", label: "은행 개발(공통)" },
  { key: "centralProd", label: "중앙회 운영" },
  { key: "centralDev", label: "중앙회 개발" },
];

/** 1,463 처럼 천 단위만 끊는다. 소수는 그대로 둔다. */
function num(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString("en-US") : String(Math.round(value * 10) / 10);
}

function signed(value: number): string {
  if (value === 0) return "0";
  return value > 0 ? `+${num(value)}` : num(value);
}

export function InstanceForm({
  month,
  savedInput,
  previous,
  previousMonth,
  savedMonths,
}: {
  month: string;
  savedInput: InstanceInput | null;
  previous: PreviousMonth;
  previousMonth: string | null;
  savedMonths: Array<{ month: string; savedAt: string }>;
}) {
  const [input, setInput] = useState<InstanceInput>(savedInput ?? EMPTY);
  // 앞선 달이 저장돼 있으면(previousMonth !== null) 이 값은 읽기 전용이다.
  const [prev, setPrev] = useState<PreviousMonth>(previous);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const manualPrev = previousMonth === null;
  const result = useMemo(() => calculateInstances(input, prev), [input, prev]);
  const filled = useMemo(
    () => GROUPS.some((g) => ENVS.some((e) => input[g.key][e.key] > 0)),
    [input],
  );

  function set(group: Group, env: Env, raw: string): void {
    const value = raw.trim() === "" ? 0 : Number(raw);
    if (!Number.isFinite(value) || value < 0) return;
    setInput((cur) => ({ ...cur, [group]: { ...cur[group], [env]: value } }));
    setSavedAt(null);
  }

  function setPrevField(key: keyof PreviousMonth, raw: string): void {
    const value = raw.trim() === "" ? 0 : Number(raw);
    if (!Number.isFinite(value) || value < 0) return;
    setPrev((cur) => ({ ...cur, [key]: value }));
    setSavedAt(null);
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/report/instances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 전월값은 사람이 넣은 경우에만 보낸다. 앞선 달이 있으면 서버가 그걸 쓴다.
        body: JSON.stringify({ month, input, previous: manualPrev ? prev : null }),
      });
      const body = (await response.json()) as { ok?: boolean; message?: string; savedAt?: string };
      if (!response.ok || body.ok !== true) {
        setError(body.message ?? `저장에 실패했습니다 (HTTP ${response.status}).`);
        return;
      }
      setSavedAt(body.savedAt ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 중 오류가 발생했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", gap: 22, alignItems: "flex-start" }}>
      {/* 왼쪽: 입력 */}
      <section style={{ width: 322, flexShrink: 0 }}>
        <Card style={{ padding: "18px 20px", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
            <Label>대상 월</Label>
            <select
              value={month}
              onChange={(e) => { window.location.href = `/report?month=${e.target.value}`; }}
              style={{ ...controlStyle, padding: "6px 10px", fontSize: 13 }}
            >
              {[month, ...savedMonths.map((m) => m.month)]
                .filter((m, i, all) => all.indexOf(m) === i)
                .sort((a, b) => b.localeCompare(a))
                .map((m) => (
                  <option key={m} value={m}>{m.replace("-", "년 ")}월</option>
                ))}
            </select>
          </div>

          {/* 3 x 3 표. 칸을 넓게 두면 세로로 길어져 한눈에 안 들어온다. */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "84px repeat(3, 1fr)",
            gap: "6px 8px",
            alignItems: "center",
          }}>
            <span />
            {ENVS.map((e) => (
              <span key={e.key} style={{
                fontSize: 11, color: COLOR.faint, textAlign: "center",
              }}>
                {e.label}
              </span>
            ))}

            {GROUPS.map((g) => (
              <Fragment key={g.key}>
                <span style={{ fontSize: 12.5, color: COLOR.ink, fontWeight: 500 }}>
                  {g.label}
                </span>
                {ENVS.map((e) => (
                  <input
                    key={e.key}
                    type="number" min={0} inputMode="numeric"
                    value={input[g.key][e.key] === 0 ? "" : input[g.key][e.key]}
                    onChange={(ev) => set(g.key, e.key, ev.target.value)}
                    placeholder="0"
                    style={{
                      ...controlStyle, width: "100%", padding: "7px 8px",
                      fontFamily: MONO_STACK, fontSize: 12.5, textAlign: "right",
                    }}
                  />
                ))}
              </Fragment>
            ))}
          </div>
          <p style={{ margin: "9px 0 0", fontSize: 11, color: COLOR.faint }}>
            공동 ORG 는 은행·중앙회가 나눠 씁니다.
          </p>
        </Card>

        <Card style={{ padding: "16px 18px", marginBottom: 14 }}>
          <Label>전월 인스턴스</Label>

          {manualPrev ? (
            <>
              <p style={{ margin: "8px 0 13px", fontSize: 12.5, color: COLOR.body, lineHeight: 1.7 }}>
                저장된 이전 달이 없습니다. <b>증감 계산에 쓸 전월 값을 넣어주세요.</b>
                <br />
                <span style={{ color: COLOR.faint, fontSize: 11.5 }}>
                  이번 한 번만 입력하면 됩니다. 다음 달부터는 자동으로 불러옵니다.
                </span>
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {PREV_FIELDS.map((f) => (
                  <label key={f.key} style={{ display: "block" }}>
                    <span style={{
                      display: "block", fontSize: 11, color: COLOR.faint, marginBottom: 4,
                    }}>
                      {f.label}
                    </span>
                    <input
                      type="number" min={0} inputMode="numeric"
                      value={prev[f.key] === 0 ? "" : prev[f.key]}
                      onChange={(ev) => setPrevField(f.key, ev.target.value)}
                      placeholder="0"
                      style={{
                        ...controlStyle, width: "100%", padding: "7px 10px",
                        fontFamily: MONO_STACK, fontSize: 12.5, textAlign: "right",
                      }}
                    />
                  </label>
                ))}
              </div>
            </>
          ) : (
            <>
              <p style={{ margin: "8px 0 11px", fontSize: 12.5, color: COLOR.body, lineHeight: 1.7 }}>
                <b>{previousMonth.replace("-", "년 ")}월</b> 저장분을 불러왔습니다.
              </p>
              <div style={{
                display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5px 14px",
                padding: "11px 13px", background: COLOR.ground, borderRadius: RADIUS.control,
              }}>
                {PREV_FIELDS.map((f) => (
                  <div key={f.key} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ fontSize: 11.5, color: COLOR.faint }}>{f.label}</span>
                    <span style={{ fontFamily: MONO_STACK, fontSize: 12, color: COLOR.body }}>
                      {num(prev[f.key])}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>

        {error !== "" && <Notice tone="warn">{error}</Notice>}
        {savedAt !== null && error === "" && (
          <Notice tone="ok">{`${month.replace("-", "년 ")}월 값을 저장했습니다.`}</Notice>
        )}

        <button
          type="button" onClick={() => void save()} disabled={busy || !filled}
          style={{
            ...controlStyle, width: "100%", padding: "11px 0", marginTop: 4,
            fontSize: 13.5, fontWeight: 600,
            background: filled ? COLOR.accent : COLOR.ground,
            color: filled ? "#ffffff" : COLOR.faint,
            borderColor: filled ? COLOR.accent : COLOR.field,
            cursor: busy || !filled ? "default" : "pointer",
          }}
        >
          {busy ? "저장 중…" : "저장"}
        </button>
      </section>

      {/* 오른쪽: 계산 결과 — 슬라이드 1 과 같은 구조 */}
      <section style={{ flex: 1, minWidth: 0 }}>
        <Card style={{ padding: "18px 20px", marginBottom: 14 }}>
          <Label>01 클라우드 운영 현황</Label>
          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr>
                  {["법인", "운영구분", "클러스터", "호스트", "Container (AI)", "비고", "증감"]
                    .map((h) => (
                      <th key={h} style={th}>{h}</th>
                    ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr key={`${row.entity}-${row.kind}`}>
                    <td style={{ ...td, fontWeight: row.entity === "" ? 400 : 600 }}>{row.entity}</td>
                    <td style={td}>{row.kind}</td>
                    <td style={tdNum}>{row.cluster}</td>
                    <td style={tdNum}>{row.host}</td>
                    <td style={{ ...tdNum, fontWeight: 600 }}>{num(row.container)}</td>
                    <td style={{ ...td, fontSize: 11.5, color: COLOR.muted }}>{row.note}</td>
                    <td style={{ ...tdNum, color: deltaColor(row.delta) }}>{signed(row.delta)}</td>
                  </tr>
                ))}
                <tr>
                  <td style={{ ...td, ...totalCell, fontWeight: 700 }} colSpan={2}>합계</td>
                  <td style={{ ...tdNum, ...totalCell }}>{result.total.cluster}</td>
                  <td style={{ ...tdNum, ...totalCell }}>{result.total.host}</td>
                  <td style={{ ...tdNum, ...totalCell, fontWeight: 700 }}>
                    {num(result.total.container)}
                  </td>
                  <td style={{ ...td, ...totalCell }} />
                  <td style={{ ...tdNum, ...totalCell, color: deltaColor(result.total.delta) }}>
                    {signed(result.total.delta)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>

        <Card style={{ padding: "18px 20px" }}>
          <Label>실 운영 현황</Label>
          <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
            <Figure label="은행" value={result.actual.bank} />
            <Figure label="중앙회" value={result.actual.central} />
            <Figure label="합계" value={result.actual.total} strong />
          </div>
          <p style={{ margin: "13px 0 0", fontSize: 11.5, color: COLOR.faint, lineHeight: 1.6 }}>
            공동 인스턴스를 반씩 나눈 값입니다. 홀수면 은행이 올림, 중앙회가 내림입니다.
          </p>
        </Card>
      </section>
    </div>
  );
}

function deltaColor(value: number): string {
  if (value > 0) return COLOR.ok;
  if (value < 0) return COLOR.waitUs;
  return COLOR.faint;
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 600, color: COLOR.faint, letterSpacing: "0.04em",
    }}>
      {children}
    </div>
  );
}

function Figure({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) {
  return (
    <div style={{
      flex: 1, padding: "13px 15px", borderRadius: RADIUS.control,
      background: strong ? COLOR.accent : COLOR.ground,
      color: strong ? "#ffffff" : COLOR.ink,
    }}>
      <div style={{
        fontSize: 11, marginBottom: 5,
        color: strong ? "rgba(255,255,255,.75)" : COLOR.faint,
      }}>
        {label}
      </div>
      <div style={{ fontFamily: MONO_STACK, fontSize: 20, fontWeight: 700 }}>{num(value)}</div>
    </div>
  );
}

const th: React.CSSProperties = {
  padding: "8px 10px", textAlign: "left", fontWeight: 600, fontSize: 11.5,
  color: COLOR.faint, borderBottom: `1px solid ${COLOR.line}`, whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  padding: "9px 10px", borderBottom: `1px solid ${COLOR.divider}`, color: COLOR.body,
};
const tdNum: React.CSSProperties = {
  ...td, fontFamily: MONO_STACK, textAlign: "right", whiteSpace: "nowrap",
};
const totalCell: React.CSSProperties = {
  borderTop: `2px solid ${COLOR.line}`, borderBottom: "none", background: COLOR.ground,
};
