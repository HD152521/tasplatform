"use client";

import { useCallback, useEffect, useState } from "react";
import type { WeeklyDigest } from "../../lib/weeklyDigest.ts";
// 값(함수)은 **순수 모듈**에서 가져온다. lib/weeklyDigest.ts 에서 가져오면 pg 가
// 브라우저 번들로 따라 들어온다(lib/weekRange.ts 머리말).
import { describeWeek, recentWeeks, weekMondayOf } from "../../lib/weekRange.ts";
import { COLOR, Card, MONO_STACK, RADIUS, controlStyle, formatStamp } from "../ui.tsx";

/**
 * 주간 자동 정리.
 *
 * 캘린더 화면 아래에 둔다 — 재료(일정·메모)가 바로 위에 있어서, 정리가 비면
 * "무엇을 더 적어야 하는지" 가 같은 화면에서 보인다.
 *
 * 화면 진입이 "지난 주 정리가 없으면 만든다" 를 한 번 깨운다(주당 한 번).
 */
export function WeeklyDigestCard({ today }: { today: string }) {
  const weeks = recentWeeks(today, 8);
  const [week, setWeek] = useState(weeks[1] ?? weeks[0] ?? weekMondayOf(today));
  const [digest, setDigest] = useState<WeeklyDigest | null>(null);
  const [recent, setRecent] = useState<readonly WeeklyDigest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);

  const load = useCallback(
    async (target: string, kick: boolean): Promise<void> => {
      try {
        const params = new URLSearchParams({ week: target });
        if (kick) params.set("today", today);
        const res = await fetch(`/api/calendar/digest?${params.toString()}`);
        const data = (await res.json()) as {
          ok?: boolean;
          digest?: WeeklyDigest | null;
          recent?: WeeklyDigest[];
          message?: string;
        };
        if (data.ok === true) {
          setDigest(data.digest ?? null);
          setRecent(data.recent ?? []);
        } else {
          setError(data.message ?? "정리를 읽지 못했습니다.");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [today],
  );

  // 첫 렌더에서 한 번. `kick=true` 로 지난 주 정리를 깨운다.
  useEffect(() => {
    void load(week, true);
    // week 가 바뀔 때는 아래 onChange 에서 다시 읽는다 — 매번 깨우지는 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function build(ruleOnly: boolean): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/calendar/digest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ week, ruleOnly }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        digest?: WeeklyDigest;
        recent?: WeeklyDigest[];
        message?: string;
      };
      if (data.ok === true && data.digest !== undefined) {
        setDigest(data.digest);
        setRecent(data.recent ?? []);
        setOpen(true);
      } else {
        setError(data.message ?? "정리를 만들지 못했습니다.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const madeWeeks = new Set(recent.map((d) => d.week));

  return (
    <Card style={{ padding: "16px 18px", marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>주간 정리</div>

        <select
          value={week}
          onChange={(e) => {
            setWeek(e.target.value);
            setDigest(null);
            void load(e.target.value, false);
          }}
          style={{ ...controlStyle, fontSize: 12.5 }}
        >
          {weeks.map((w, i) => (
            <option key={w} value={w}>
              {describeWeek(w)}
              {i === 0 ? " · 이번 주" : i === 1 ? " · 지난 주" : ""}
              {madeWeeks.has(w) ? " ✓" : ""}
            </option>
          ))}
        </select>

        <button
          type="button"
          disabled={busy}
          onClick={() => void build(false)}
          style={{ ...controlStyle, fontSize: 12.5, opacity: busy ? 0.6 : 1 }}
        >
          {busy ? "정리 중…" : digest === null ? "정리 만들기" : "다시 만들기"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void build(true)}
          title="LLM 을 쓰지 않고 집계만 합니다"
          style={{ ...controlStyle, fontSize: 12.5, opacity: busy ? 0.6 : 1 }}
        >
          집계만
        </button>

        {digest !== null && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            style={{ ...controlStyle, fontSize: 12.5, marginLeft: "auto" }}
          >
            {open ? "접기 ▲" : "펼치기 ▼"}
          </button>
        )}
      </div>

      <p style={{ margin: "10px 0 0", fontSize: 12, color: COLOR.muted, lineHeight: 1.75 }}>
        그 주의 일정과 <strong>작업 메모</strong>를 모아 사람별로 정리합니다. 일정을 눌러 메모를
        남겨 두면 그 내용이 그대로 들어갑니다.{" "}
        <strong>LLM 이 없거나 실패해도</strong> 집계 기반 정리가 나옵니다.
      </p>

      {error !== "" && (
        <p style={{ margin: "10px 0 0", fontSize: 12.5, color: COLOR.waitUs }}>{error}</p>
      )}

      {digest !== null && (
        <>
          <div style={{ marginTop: 12, fontSize: 11.5, color: COLOR.faint }}>
            {formatStamp(Date.parse(digest.createdAt))} 생성 ·{" "}
            {digest.source === "llm" ? "LLM 이 다듬음" : "집계 기반(LLM 미사용)"}
            {digest.createdBy !== "" && ` · ${digest.createdBy}`}
          </div>

          {open && (
            <pre style={{
              marginTop: 10, marginBottom: 0, padding: "14px 16px",
              background: COLOR.ground, borderRadius: RADIUS.control,
              fontFamily: MONO_STACK, fontSize: 12.5, lineHeight: 1.85,
              whiteSpace: "pre-wrap", wordBreak: "break-word", color: COLOR.ink,
            }}>
              {digest.body}
            </pre>
          )}
        </>
      )}

      {digest === null && error === "" && (
        <p style={{ margin: "10px 0 0", fontSize: 12.5, color: COLOR.faint }}>
          이 주의 정리가 아직 없습니다. 「정리 만들기」를 누르세요.
        </p>
      )}
    </Card>
  );
}
