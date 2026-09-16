/**
 * Wolken 날짜 문자열 파서.
 * 포털이 내려주는 형식: "01-September-2026 23:54:12"  (dd-MMMM-yyyy HH:mm:ss)
 */

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
] as const;

const PATTERN = /^(\d{1,2})-([A-Za-z]+)-(\d{4})[ T](\d{1,2}):(\d{2}):(\d{2})$/;

/** 파싱 실패 시 null. 절대 예외를 던지거나 잘못된 날짜를 만들어내지 않는다. */
export function parseWolkenDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = PATTERN.exec(value.trim());
  if (!m) return null;

  const [, dd, monthName, yyyy, hh, mi, ss] = m;
  const monthIndex = MONTHS.indexOf(monthName!.toLowerCase() as (typeof MONTHS)[number]);
  if (monthIndex < 0) return null;

  const date = new Date(
    Number(yyyy), monthIndex, Number(dd),
    Number(hh), Number(mi), Number(ss),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 정렬·비교용 epoch ms. 파싱 실패 시 null. */
export function toEpochMs(value: string | null | undefined): number | null {
  return parseWolkenDate(value)?.getTime() ?? null;
}

export function monthsBefore(months: number, from: Date = new Date()): Date {
  const d = new Date(from.getTime());
  d.setMonth(d.getMonth() - months);
  return d;
}

export function isoNow(): string {
  return new Date().toISOString();
}
