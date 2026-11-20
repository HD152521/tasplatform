/**
 * 한 줄 일정 입력 파서.
 *
 * ```
 * 11/25 방화벽 점검 @용식 #점검
 * 내일 14:00-16:00 VCF 패치 @민수 #작업
 * 25~27 정기점검 준비
 * 방화벽 룰 정리                      ← 날짜가 없으면 지금 보고 있는 날
 * ```
 *
 * ## 왜 폼이 아니라 한 줄인가
 *
 * 요구의 핵심이 "등록·수정·삭제가 간편해야 한다" 였다. 칸 여섯 개짜리 모달은 한 건
 * 적는 데 클릭이 열 번 든다. 그러면 사람이 **적지 않는다** — 적지 않은 캘린더는
 * 주간 정리의 재료도 못 된다. 그래서 입력 비용을 타이핑 한 줄로 내린다.
 *
 * ## 왜 순수 함수인가
 *
 * 브라우저도 DB 도 쓰지 않는다. 그래서
 *   - 서버(저장)와 화면(미리보기)이 **같은 함수**를 쓴다. 미리보기와 실제 저장 결과가
 *     어긋날 길이 없다 — 어긋나면 한 줄 입력을 믿을 수 없게 된다.
 *   - 애매한 입력의 동작을 단위 시험으로 문서처럼 잠근다.
 *
 * ## 날짜를 Date 로 다루지 않는다
 *
 * 결과는 'YYYY-MM-DD' 문자열이다. 서버가 UTC 면 `new Date()` 기준 날짜가 KST 와
 * 하루 어긋난다(자정 무렵). 그래서 기준일(`today`)을 **호출자가 문자열로 넘긴다** —
 * 화면은 브라우저의 로컬 날짜를, 서버는 요청에 실려 온 그 날짜를 쓴다.
 */

/** 일정 종류. 목록에 없는 `#태그` 도 그대로 받는다 — 쓰면서 늘어나는 값이다. */
export const EVENT_KINDS = ["점검", "작업", "장애", "회의", "휴가", "교육"] as const;

export interface QuickAddResult {
  /** 'YYYY-MM-DD' */
  readonly startDate: string;
  /** 'YYYY-MM-DD'. 하루 일정이면 startDate 와 같다. */
  readonly endDate: string;
  /** 'HH:MM' 또는 ''(종일) */
  readonly startTime: string;
  readonly endTime: string;
  readonly title: string;
  /** `#태그`. 없으면 ''. */
  readonly kind: string;
  /** `@이름`. 없으면 ''. 팀원과 맞추는 것은 부르는 쪽의 일이다. */
  readonly assignee: string;
  /** 날짜 조각이 실제로 적혀 있었나. 미리보기가 "오늘로 봤다" 를 말해 주려고 쓴다. */
  readonly hadDate: boolean;
  /** 사람에게 보여 줄 한 줄 요약. */
  readonly summary: string;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/* ------------------------------------------------------------------ *
 * 날짜 산수 — 전부 'YYYY-MM-DD' 문자열 위에서 한다
 * ------------------------------------------------------------------ */

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function isDateString(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12) return false;
  return d >= 1 && d <= daysInMonth(y, m);
}

export function daysInMonth(year: number, month: number): number {
  // month 는 1..12. Date.UTC 의 day=0 은 "그 달의 마지막 날" 이다.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 날짜 문자열에 일수를 더한다. UTC 자정으로만 계산해 서버 시간대와 무관하게 만든다. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  at.setUTCDate(at.getUTCDate() + days);
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

/** 'YYYY-MM-DD' → 요일 한 글자. */
export function weekdayOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] as string;
}

/**
 * 월·일만 적힌 날짜를 기준일 근처의 **실제 날짜**로 푼다.
 *
 * 12월에 "1/5" 를 적으면 **다음 해** 1월이다. 지난 1월로 읽으면 11개월 전에 일정이
 * 꽂히고, 달 그리드에서 사라져 "저장이 안 됐다" 로 보인다. 그래서 기준일보다
 * 많이 과거면(두 달 넘게) 다음 해로 본다.
 */
function resolveMonthDay(today: string, month: number, day: number): string | null {
  const [ty] = today.split("-").map(Number) as [number];
  for (const year of [ty, ty + 1, ty - 1]) {
    if (month < 1 || month > 12) return null;
    if (day < 1 || day > daysInMonth(year, month)) continue;
    const candidate = `${year}-${pad(month)}-${pad(day)}`;
    const gap = daysBetween(today, candidate);
    if (gap >= -62) return candidate;
  }
  return null;
}

/** b - a (일). 둘 다 'YYYY-MM-DD'. */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number) as [number, number, number];
  const [by, bm, bd] = b.split("-").map(Number) as [number, number, number];
  const ms = Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad);
  return Math.round(ms / 86_400_000);
}

/** 그 달의 같은 일(day). 기준 달 안에서 `25~27` 처럼 일만 적을 때 쓴다. */
function sameMonthDay(today: string, day: number): string | null {
  const [y, m] = today.split("-").map(Number) as [number, number];
  if (day < 1 || day > daysInMonth(y, m)) return null;
  return `${y}-${pad(m)}-${pad(day)}`;
}

/* ------------------------------------------------------------------ *
 * 조각 뜯어내기
 * ------------------------------------------------------------------ */

const RELATIVE: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(오늘|금일|today)$/i, 0],
  [/^(내일|명일|tomorrow)$/i, 1],
  [/^(모레|내일모레)$/i, 2],
  [/^(어제|yesterday)$/i, -1],
];

/** `M/D` 또는 `M-D` 또는 `M.D` */
const MONTH_DAY = /^(\d{1,2})[./-](\d{1,2})$/;
/** `M/D~M/D` (물결·하이픈·`..`) */
const RANGE_FULL = /^(\d{1,2})[./-](\d{1,2})\s*(?:~|-|–|\.\.)\s*(\d{1,2})[./-](\d{1,2})$/;
/** `M/D~D` — 끝 날짜의 달을 생략한 꼴 */
const RANGE_TAIL = /^(\d{1,2})[./-](\d{1,2})\s*(?:~|–|\.\.)\s*(\d{1,2})$/;
/** `D~D` — 이번 달 안의 기간 */
const RANGE_DAYS = /^(\d{1,2})\s*(?:~|–|\.\.)\s*(\d{1,2})$/;
/**
 * `YYYY-MM-DD~YYYY-MM-DD` — 인라인 편집이 되돌려 주는 꼴(formatQuickAddLine).
 * 구분자에 하이픈을 두지 않는다 — ISO 날짜 안에 이미 하이픈이 있어 가를 수 없다.
 */
const RANGE_ISO = /^(\d{4}-\d{2}-\d{2})\s*(?:~|–|\.\.)\s*(\d{4}-\d{2}-\d{2})$/;
/** `HH:MM-HH:MM` */
const TIME_RANGE = /^(\d{1,2}):(\d{2})\s*(?:~|-|–)\s*(\d{1,2}):(\d{2})$/;
/** `HH:MM` */
const TIME_ONE = /^(\d{1,2}):(\d{2})$/;

function validTime(h: number, m: number): boolean {
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

interface DatePart {
  readonly startDate: string;
  readonly endDate: string;
}

/**
 * 토큰 하나를 날짜(또는 기간)로 읽어 본다. 날짜가 아니면 null.
 *
 * **기간 표기를 단일 날짜보다 먼저 본다.** `11/25-11/27` 을 `M-D` 로 먼저 읽으면
 * "11월 25일" 로 잘리고 뒤가 제목이 된다.
 */
function readDate(token: string, today: string): DatePart | null {
  for (const [pattern, offset] of RELATIVE) {
    if (pattern.test(token)) {
      const date = addDays(today, offset);
      return { startDate: date, endDate: date };
    }
  }

  const iso = RANGE_ISO.exec(token);
  if (iso) {
    const [, a, b] = iso as unknown as [string, string, string];
    if (!isDateString(a) || !isDateString(b)) return null;
    return order(a, b);
  }

  const full = RANGE_FULL.exec(token);
  if (full) {
    const start = resolveMonthDay(today, Number(full[1]), Number(full[2]));
    if (start === null) return null;
    // 끝 날짜는 **시작 날짜를 기준으로** 푼다. 12/30~1/2 처럼 해를 넘는 기간이
    // 오늘 기준으로는 작년으로 떨어질 수 있다.
    const end = resolveMonthDay(start, Number(full[3]), Number(full[4]));
    if (end === null) return null;
    return order(start, end);
  }

  const tail = RANGE_TAIL.exec(token);
  if (tail) {
    const start = resolveMonthDay(today, Number(tail[1]), Number(tail[2]));
    if (start === null) return null;
    const [sy, sm] = start.split("-").map(Number) as [number, number];
    const day = Number(tail[3]);
    if (day < 1 || day > daysInMonth(sy, sm)) return null;
    return order(start, `${sy}-${pad(sm)}-${pad(day)}`);
  }

  const one = MONTH_DAY.exec(token);
  if (one) {
    const date = resolveMonthDay(today, Number(one[1]), Number(one[2]));
    return date === null ? null : { startDate: date, endDate: date };
  }

  const days = RANGE_DAYS.exec(token);
  if (days) {
    const start = sameMonthDay(today, Number(days[1]));
    const end = sameMonthDay(today, Number(days[2]));
    if (start === null || end === null) return null;
    return order(start, end);
  }

  if (DATE_ONLY.test(token) && isDateString(token)) {
    return { startDate: token, endDate: token };
  }
  return null;
}

/** 거꾸로 적힌 기간을 바로 돌린다 — `27~25` 를 거부하기보다 사람 뜻대로 읽는다. */
function order(a: string, b: string): DatePart {
  return daysBetween(a, b) < 0 ? { startDate: b, endDate: a } : { startDate: a, endDate: b };
}

interface TimePart {
  readonly startTime: string;
  readonly endTime: string;
}

function readTime(token: string): TimePart | null {
  const range = TIME_RANGE.exec(token);
  if (range) {
    const sh = Number(range[1]);
    const sm = Number(range[2]);
    const eh = Number(range[3]);
    const em = Number(range[4]);
    if (!validTime(sh, sm) || !validTime(eh, em)) return null;
    return { startTime: `${pad(sh)}:${pad(sm)}`, endTime: `${pad(eh)}:${pad(em)}` };
  }
  const one = TIME_ONE.exec(token);
  if (one) {
    const h = Number(one[1]);
    const m = Number(one[2]);
    if (!validTime(h, m)) return null;
    return { startTime: `${pad(h)}:${pad(m)}`, endTime: "" };
  }
  return null;
}

/**
 * 한 줄을 읽는다.
 *
 * `today` 는 'YYYY-MM-DD' 기준일(화면에서 선택한 날짜 또는 오늘). 형식이 아니면 던진다 —
 * 기준일이 틀리면 상대 날짜가 전부 틀리고, 그 상태로 조용히 저장하면 사람은 일정이
 * 사라진 줄 안다.
 */
export function parseQuickAdd(line: string, today: string): QuickAddResult {
  if (!isDateString(today)) {
    throw new Error(`기준 날짜가 'YYYY-MM-DD' 형식이 아닙니다: ${JSON.stringify(today)}`);
  }

  let date: DatePart | null = null;
  let time: TimePart | null = null;
  let kind = "";
  let assignee = "";
  const rest: string[] = [];

  for (const token of line.trim().split(/\s+/)) {
    if (token === "") continue;

    if (token.startsWith("#") && token.length > 1) {
      // 첫 태그만 쓴다. 두 번째부터는 제목에 남겨 둔다 — 버리면 적은 사람이 모른다.
      if (kind === "") {
        kind = token.slice(1);
        continue;
      }
      rest.push(token);
      continue;
    }
    if (token.startsWith("@") && token.length > 1) {
      if (assignee === "") {
        assignee = token.slice(1);
        continue;
      }
      rest.push(token);
      continue;
    }

    if (date === null) {
      const parsed = readDate(token, today);
      if (parsed !== null) {
        date = parsed;
        continue;
      }
    }
    if (time === null) {
      const parsed = readTime(token);
      if (parsed !== null) {
        time = parsed;
        continue;
      }
    }
    rest.push(token);
  }

  const startDate = date?.startDate ?? today;
  const endDate = date?.endDate ?? startDate;
  const title = rest.join(" ").trim();

  const result = {
    startDate,
    endDate,
    startTime: time?.startTime ?? "",
    endTime: time?.endTime ?? "",
    title,
    kind,
    assignee,
    hadDate: date !== null,
  };
  return { ...result, summary: describeQuickAdd(result) };
}

/** 한 줄로 되돌릴 수 있는 일정 조각. */
export interface QuickAddFields {
  readonly startDate: string;
  readonly endDate: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly title: string;
  readonly kind: string;
  readonly assignee: string;
}

/**
 * 일정을 **다시 한 줄로** 적는다. 인라인 편집이 이 문자열을 입력칸에 채운다.
 *
 * 왜 필요한가: 수정도 같은 한 줄 문법으로 하기 위해서다. 편집할 때만 칸 여섯 개짜리
 * 폼이 뜨면 "간편함" 이 등록에만 적용되고 수정에는 없다.
 *
 * 날짜를 `YYYY-MM-DD` 로 적는다(`M/D` 가 아니라). `M/D` 는 기준일에 따라 해가 달라지는데,
 * 편집은 기준일이 "그 일정의 날짜" 라서 괜찮아 보이지만 — 사람이 그 줄을 다른 날에
 * 다시 저장하면 해가 바뀐다. **왕복이 어긋나지 않는 쪽**을 고른다.
 */
export function formatQuickAddLine(f: QuickAddFields): string {
  const parts: string[] = [];
  parts.push(f.endDate === f.startDate ? f.startDate : `${f.startDate}~${f.endDate}`);
  if (f.startTime !== "") {
    parts.push(f.endTime === "" ? f.startTime : `${f.startTime}-${f.endTime}`);
  }
  if (f.title !== "") parts.push(f.title);
  if (f.assignee !== "") parts.push(`@${f.assignee}`);
  if (f.kind !== "") parts.push(`#${f.kind}`);
  return parts.join(" ");
}

/**
 * 미리보기 한 줄. `11/25(화) 종일 · 점검 · 담당 용식`
 *
 * 이게 한 줄 입력을 **믿게 만드는** 장치다. 파서가 틀리게 읽었으면 Enter 를 누르기
 * 전에 눈에 보인다.
 */
export function describeQuickAdd(r: Omit<QuickAddResult, "summary">): string {
  const parts: string[] = [];

  const start = `${Number(r.startDate.slice(5, 7))}/${Number(r.startDate.slice(8, 10))}(${weekdayOf(r.startDate)})`;
  if (r.endDate !== r.startDate) {
    const end = `${Number(r.endDate.slice(5, 7))}/${Number(r.endDate.slice(8, 10))}(${weekdayOf(r.endDate)})`;
    parts.push(`${start}~${end} ${daysBetween(r.startDate, r.endDate) + 1}일간`);
  } else {
    parts.push(start);
  }

  if (r.startTime === "") parts.push("종일");
  else parts.push(r.endTime === "" ? r.startTime : `${r.startTime}~${r.endTime}`);

  if (r.kind !== "") parts.push(r.kind);
  if (r.assignee !== "") parts.push(`담당 ${r.assignee}`);
  if (!r.hadDate) parts.push("날짜 안 적음 → 선택한 날");
  if (r.title === "") parts.push("⚠ 제목이 비었습니다");

  return parts.join(" · ");
}
