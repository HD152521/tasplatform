"use client";

/**
 * 대상 월 선택.
 *
 * 예전에는 "현재 달 + 이미 저장된 달" 만 고를 수 있었다. 아직 한 번도 안 만든 달은
 * 목록에 없어서 사실상 고정이었다 — 9월에 8월 보고서를 만들려면 URL 을 손으로 고쳐야 했다.
 * 연도와 월을 따로 고르게 해서 어느 달이든 바로 열 수 있게 한다.
 *
 * 이미 저장된 달에는 표시를 붙인다. 어느 달을 이미 만들었는지가 목록을 여는 가장 큰
 * 이유이기 때문이다.
 */
import { COLOR, controlStyle } from "../ui.tsx";

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/** 고를 수 있는 연도. 올해를 기준으로 뒤로 3년, 앞으로 1년. */
function yearRange(current: number): number[] {
  const thisYear = new Date().getFullYear();
  const from = Math.min(thisYear - 3, current);
  const to = Math.max(thisYear + 1, current);
  const years: number[] = [];
  for (let y = to; y >= from; y -= 1) years.push(y);
  return years;
}

export default function MonthPicker({
  month,
  step,
  savedMonths,
}: {
  /** 'YYYY-MM' */
  month: string;
  step: number;
  /** 이미 저장된 달. 표시를 붙이는 데만 쓴다. */
  savedMonths: readonly string[];
}) {
  const [rawYear, rawMonth] = month.split("-");
  const year = Number(rawYear);
  const monthNo = Number(rawMonth);
  const saved = new Set(savedMonths);

  const go = (nextYear: number, nextMonth: number): void => {
    const key = `${nextYear}-${String(nextMonth).padStart(2, "0")}`;
    // 단계를 유지한다 — 월만 바꾸려는 것이지 처음부터 다시 하려는 것이 아니다.
    window.location.href = `/report?month=${key}&step=${step}`;
  };

  const select = { ...controlStyle, padding: "6px 10px", fontSize: 13 };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <select
        aria-label="연도"
        value={year}
        onChange={(e) => go(Number(e.target.value), monthNo)}
        style={select}
      >
        {yearRange(year).map((y) => (
          <option key={y} value={y}>{`${y}년`}</option>
        ))}
      </select>
      <select
        aria-label="월"
        value={monthNo}
        onChange={(e) => go(year, Number(e.target.value))}
        style={select}
      >
        {MONTHS.map((m) => {
          const key = `${year}-${String(m).padStart(2, "0")}`;
          // 저장된 달에는 점을 붙인다. option 에는 스타일이 잘 안 먹어서 글자로 표시한다.
          return (
            <option key={m} value={m}>
              {`${m}월${saved.has(key) ? " ·" : ""}`}
            </option>
          );
        })}
      </select>
      {saved.has(month) && (
        <span style={{ fontSize: 11, color: COLOR.faint, whiteSpace: "nowrap" }}>저장됨</span>
      )}
    </div>
  );
}
