/**
 * 주 경계 계산 — **순수 함수만.**
 *
 * ## 왜 weeklyDigest.ts 에서 떼어 냈나
 *
 * 화면(클라이언트 컴포넌트)이 주 목록을 그려야 한다. 그런데 `lib/weeklyDigest.ts` 는
 * DB(`pg`)와 LLM 을 끌어오므로, 거기서 함수 하나만 가져와도 **`pg` 가 브라우저
 * 번들로 따라 들어온다** — `Can't resolve 'dns'` 로 빌드가 깨진다(실측).
 *
 * 그래서 날짜 산수만 여기 둔다. 이 파일은 `lib/quickAdd.ts`(역시 순수) 외에 아무것도
 * 쓰지 않는다. 서버 쪽은 weeklyDigest.ts 가 그대로 다시 내보낸다.
 *
 * 주의 시작은 **월요일**이다. "이번 주에 한 일" 을 묻는 감각이 월~금이고, 일요일
 * 시작으로 두면 금요일에 만든 정리가 다음 주 것처럼 보인다.
 */
import { addDays, daysBetween, isDateString, weekdayOf } from "./quickAdd.ts";

const WEEKDAY_INDEX: Record<string, number> = {
  일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6,
};

/** 그 날짜가 속한 주의 **월요일**. */
export function weekMondayOf(date: string): string {
  if (!isDateString(date)) {
    throw new Error(`날짜가 'YYYY-MM-DD' 형식이 아닙니다: ${JSON.stringify(date)}`);
  }
  const day = WEEKDAY_INDEX[weekdayOf(date)] ?? 1;
  // 일요일(0)은 **지난 월요일**에 붙인다(-6). 안 그러면 일요일 하루만 다음 주가 된다.
  return addDays(date, day === 0 ? -6 : 1 - day);
}

/** 그 주의 월~일. */
export function weekRange(week: string): { from: string; to: string } {
  const monday = weekMondayOf(week);
  return { from: monday, to: addDays(monday, 6) };
}

/** `11/24(월)~11/30(일)` */
export function describeWeek(week: string): string {
  const { from, to } = weekRange(week);
  const label = (date: string): string =>
    `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}(${weekdayOf(date)})`;
  return `${label(from)}~${label(to)}`;
}

/** 지난 몇 주의 월요일 목록(최근 것부터). 화면의 주 선택에 쓴다. */
export function recentWeeks(today: string, count = 8): string[] {
  const monday = weekMondayOf(today);
  return Array.from({ length: count }, (_, i) => addDays(monday, -7 * i));
}

/** 두 주 사이의 간격(주). 화면이 "3주 전" 을 말할 때 쓴다. */
export function weeksAgo(today: string, week: string): number {
  return Math.round(daysBetween(weekMondayOf(week), weekMondayOf(today)) / 7);
}
