"use client";

import { useState } from "react";
import { COLOR, Card, MONO_STACK, Notice, RADIUS } from "../ui.tsx";

/**
 * 4단계 · 보고서 생성.
 *
 * 회사 양식(templates/monthly-report.pptx)을 그대로 열어 값만 채운다.
 * SR 정리는 건수만큼 AI 를 부르므로 몇 분 걸린다 — 그 사실을 미리 알린다.
 */
export function BuildStep({
  month, srCount, workCount, hasInstances,
}: {
  month: string;
  srCount: number;
  workCount: number;
  hasInstances: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const blockers: string[] = [];
  if (!hasInstances) blockers.push("1단계 인스턴스 수가 저장되지 않았습니다.");
  if (srCount === 0) blockers.push("2단계에서 고른 SR 이 없습니다.");

  async function build(): Promise<void> {
    setBusy(true);
    setError("");
    setDone("");
    try {
      const response = await fetch(`/api/report/build?month=${month}`);
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        setError(body.message ?? `생성에 실패했습니다 (HTTP ${response.status}).`);
        return;
      }
      // 파일을 받아 내려받기
      const blob = await response.blob();
      const name = `${month.replace("-", "년_")}월_정기점검_보고서.pptx`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setDone(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : "생성 중 오류가 발생했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error !== "" && <Notice tone="error">{error}</Notice>}
      {done !== "" && error === "" && (
        <Notice tone="ok">{`${done} 를 내려받았습니다.`}</Notice>
      )}

      <Card style={{ padding: "22px 24px" }}>
        <div style={{
          fontSize: 11, fontWeight: 600, color: COLOR.faint,
          letterSpacing: "0.04em", marginBottom: 15,
        }}>
          생성될 내용
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 9, marginBottom: 20 }}>
          <Line label="01 클라우드 운영 현황"
                value={hasInstances ? "인스턴스 수 저장됨" : "저장 안 됨"}
                ok={hasInstances} />
          <Line label="2-1 라이선스 현황" value="양식 그대로 (수정 안 함)" ok />
          <Line label="01 SR 진행현황 요약" value={`${srCount}건`} ok={srCount > 0} />
          <Line label="2-2 SR 상세" value={`${srCount}장 (1건당 1장)`} ok={srCount > 0} />
          <Line label="3-3 작업 진행 현황"
                value={workCount > 0 ? `${workCount}건` : "선택 없음 — 전체가 들어갑니다"}
                ok />
        </div>

        {blockers.length > 0 ? (
          <Notice tone="warn">
            {blockers.map((b) => <div key={b}>{b}</div>)}
          </Notice>
        ) : (
          <p style={{
            margin: "0 0 16px", padding: "12px 15px", background: COLOR.ground,
            borderRadius: RADIUS.control, fontSize: 12.5, color: COLOR.body, lineHeight: 1.7,
          }}>
            SR {srCount}건의 <b>분석 및 진행 상황</b>을 AI 가 정리합니다.
            처음 만들 때는 건당 20~40초 걸리고, 한 번 만든 것은 저장해 두었다가 다시 씁니다.
            <br />
            <span style={{ color: COLOR.faint, fontSize: 11.5 }}>
              생성된 내용은 초안입니다. 파일을 열어 확인하고 다듬어 주세요.
            </span>
          </p>
        )}

        <button
          type="button" onClick={() => void build()} disabled={busy || blockers.length > 0}
          style={{
            width: "100%", padding: "13px 0", fontSize: 14, fontWeight: 600,
            borderRadius: RADIUS.control, fontFamily: "inherit",
            color: blockers.length > 0 ? COLOR.faint : "#ffffff",
            background: blockers.length > 0 ? COLOR.ground : COLOR.accent,
            border: `1px solid ${blockers.length > 0 ? COLOR.field : COLOR.accent}`,
            cursor: busy || blockers.length > 0 ? "default" : "pointer",
          }}
        >
          {busy ? "만드는 중… (몇 분 걸립니다)" : "정기점검 보고서 만들기"}
        </button>
      </Card>
    </>
  );
}

function Line({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
      <span style={{
        width: 16, flexShrink: 0, textAlign: "center",
        color: ok ? COLOR.ok : COLOR.warn, fontSize: 12,
      }}>
        {ok ? "✓" : "!"}
      </span>
      <span style={{ width: 168, flexShrink: 0, fontSize: 13, color: COLOR.ink }}>{label}</span>
      <span style={{ fontFamily: MONO_STACK, fontSize: 12, color: COLOR.muted }}>{value}</span>
    </div>
  );
}
