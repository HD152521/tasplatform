/**
 * 달력 한 주를 **띠**로 눕히는 배치 계산.
 *
 * ## 왜 점이 아니라 띠인가
 *
 * 전에는 달력 칸마다 일정 수만큼 색점을 찍었다. 12~13일처럼 **이어지는 일정**이
 * 12일에 점 하나, 13일에 점 하나로 보여, 보는 사람이 "이틀짜리 하나" 인지 "하루짜리
 * 둘" 인지 구별할 수 없었다. 기간은 길이로 보여야 기간으로 읽힌다.
 *
 * 그래서 한 주를 가로로 훑어 **같은 일정을 한 칸 이상 덮는 하나의 띠**로 만든다.
 * 주 경계를 넘는 일정은 주마다 조각이 나뉘고, 각 조각이 "왼쪽/오른쪽으로 더 간다" 를
 * 들고 있어 화면에서 모서리를 깎지 않고 이어 붙인 것처럼 그릴 수 있다.
 *
 * ## 줄(lane) 을 어떻게 고르나
 *
 * 겹치는 띠는 아래위로 쌓인다. 쌓는 순서가 **주마다 달라지면** 같은 일정이 1주에는
 * 첫 줄, 2주에는 셋째 줄에 앉아 선이 끊겨 보인다. 그래서 순서를 날짜·길이로만 정한다
 * (먼저 시작한 것 → 긴 것 → 아이디) — 어느 주에서 계산해도 같은 순서가 나오므로
 * 긴 일정이 여러 주에 걸쳐 **같은 높이로** 이어진다.
 *
 * 줄은 왼쪽부터 빈 자리를 찾는 그리디로 정한다. 날짜 구간 배치에서는 이 방법이
 * 최소 줄 수를 보장한다(구간 그래프의 채색수 = 최대 겹침 수).
 *
 * 화면 높이가 유한하므로 줄을 몇 개까지 보여 줄지는 **부르는 쪽**이 정한다. 여기서는
 * 자르지 않고 줄 번호를 전부 돌려준다 — 자를 자리와 "+N" 을 어떻게 보여 줄지는
 * 화면의 사정이고, 계산은 그것을 몰라야 한다.
 */

export interface DateSpan {
  /** YYYY-MM-DD */
  readonly startDate: string;
  /** YYYY-MM-DD. startDate 보다 앞서면 하루로 본다 — 자료를 숨기지 않는다. */
  readonly endDate: string;
}

export interface WeekSegment<T> {
  readonly item: T;
  /** 이 주에서 시작하는 칸(0 = 주의 첫날). */
  readonly col: number;
  /** 덮는 칸 수(1 이상). */
  readonly span: number;
  /** 이 주보다 앞에서 시작했다 — 왼쪽 모서리를 깎지 않는다. */
  readonly continuesLeft: boolean;
  /** 이 주보다 뒤까지 간다 — 오른쪽 모서리를 깎지 않는다. */
  readonly continuesRight: boolean;
  /** 0부터. 위에서 몇 번째 줄인가. */
  readonly lane: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 두 날짜 사이 일수. 문자열 비교로는 길이를 알 수 없어 UTC 로 환산한다. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/**
 * 한 주(연속한 날짜 배열, 보통 7칸)에 걸치는 일정을 띠 조각으로 눕힌다.
 *
 * `weekDates` 는 **연속**이어야 한다(하루씩 증가). 달력 그리드가 그렇게 만든다.
 */
export function layoutWeek<T extends DateSpan>(
  items: readonly T[],
  weekDates: readonly string[],
): readonly WeekSegment<T>[] {
  if (weekDates.length === 0) return [];
  const first = weekDates[0] as string;
  const last = weekDates[weekDates.length - 1] as string;

  const hits = items
    .filter((item) => item.startDate <= last && item.endDate >= first)
    .map((item) => {
      const from = item.startDate < first ? first : item.startDate;
      // 끝이 시작보다 앞선 잘못된 자료는 하루로 본다 — 안 보이게 지우는 것보다 낫다.
      const rawTo = item.endDate > last ? last : item.endDate;
      const to = rawTo < from ? from : rawTo;
      const col = daysBetween(first, from);
      const span = daysBetween(from, to) + 1;
      return {
        item,
        col,
        span,
        continuesLeft: item.startDate < first,
        continuesRight: item.endDate > last,
      };
    })
    // 날짜가 깨져 칸 밖으로 나가는 것은 그리지 않는다(그리드를 망가뜨린다).
    .filter((seg) => seg.col >= 0 && seg.span >= 1 && seg.col + seg.span <= weekDates.length);

  // 주마다 같은 순서가 나와야 긴 일정이 같은 높이로 이어진다.
  const ordered = [...hits].sort((a, b) => {
    if (a.item.startDate !== b.item.startDate) return a.item.startDate < b.item.startDate ? -1 : 1;
    const lengthDiff =
      daysBetween(b.item.startDate, b.item.endDate) - daysBetween(a.item.startDate, a.item.endDate);
    if (lengthDiff !== 0) return lengthDiff;
    return 0;
  });

  const lanes: boolean[][] = [];
  return ordered.map((seg) => {
    let lane = 0;
    for (;;) {
      let row = lanes[lane];
      if (row === undefined) {
        row = Array.from({ length: weekDates.length }, () => false);
        lanes[lane] = row;
      }
      let free = true;
      for (let c = seg.col; c < seg.col + seg.span; c += 1) {
        if (row[c] === true) {
          free = false;
          break;
        }
      }
      if (free) {
        for (let c = seg.col; c < seg.col + seg.span; c += 1) row[c] = true;
        return { ...seg, lane };
      }
      lane += 1;
    }
  });
}

/**
 * 보여 줄 줄 수를 넘겨 가려진 띠가 **날짜별로 몇 건**인지 센다.
 *
 * 한 띠가 사흘을 덮으면 그 사흘에 각각 하나로 센다 — 사람이 그 날 칸을 보고
 * "여기 더 있다" 를 알아야 하기 때문이다.
 */
export function hiddenPerDay<T>(
  segments: readonly WeekSegment<T>[],
  laneLimit: number,
  dayCount: number,
): readonly number[] {
  const out = Array.from({ length: dayCount }, () => 0);
  for (const seg of segments) {
    if (seg.lane < laneLimit) continue;
    for (let c = seg.col; c < seg.col + seg.span && c < dayCount; c += 1) {
      out[c] = (out[c] ?? 0) + 1;
    }
  }
  return out;
}
