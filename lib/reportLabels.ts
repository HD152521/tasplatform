/**
 * 보고서에 찍히는 월 표기. 규칙을 한곳에 모아 둔다.
 *
 * ## 왜 따로 떼어 두나
 *
 * 양식 여러 곳에 지난달 날짜가 **박혀 있고 갱신되지 않았다.** 어느 달로 만들어도 그
 * 값이 그대로 나갔다. 실제로 09월 보고서에 "2026.08.31 기준" 과 "2026년 05월 …"이
 * 찍혀 나갔다(바닥글은 레이아웃에 있어 한 장씩 보면 안 보인다 — 12장 전부 같이
 * 틀린다).
 *
 * 규칙을 lib/pptx.ts 안에 즉석 함수로 두었더니 시험할 방법이 없었다. 여기로 옮겨
 * 단위테스트로 잠근다 — 반올림·사진 배치를 TS 에 두는 것과 같은 이유다.
 *
 * ## 입력
 *
 * `month` 는 `YYYY-MM` 이다. 형식이 어긋나면 **던진다.** 잘못된 달로 보고서를
 * 만들어 고객에게 보내는 것보다 만들지 못하는 편이 낫다.
 */

const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

function parseMonth(month: string): { year: number; mon: number } {
  const matched = MONTH_PATTERN.exec(month);
  if (matched === null) {
    throw new RangeError(`보고월 형식이 잘못되었습니다 (YYYY-MM 이어야 합니다): ${month}`);
  }
  const year = Number(matched[1]);
  const mon = Number(matched[2]);
  if (mon < 1 || mon > 12) {
    throw new RangeError(`보고월의 달이 1~12 범위를 벗어났습니다: ${month}`);
  }
  return { year, mon };
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** 표 머리에 넣는 달. `"09월"`. */
export function monthLabel(month: string): string {
  const { mon } = parseMonth(month);
  return `${pad2(mon)}월`;
}

/**
 * 표 오른쪽 위 기준일. `"2026.09.30 기준"`.
 *
 * `Date(연, 월, 0)` 은 그 달의 **마지막 날**이다(월이 0부터라 mon 을 그대로 넣으면
 * 다음 달 0일 = 이번 달 말일). 윤년과 30/31일을 따로 다루지 않아도 된다.
 */
export function asOfLabel(month: string): string {
  const { year, mon } = parseMonth(month);
  const lastDay = new Date(year, mon, 0).getDate();
  return `${year}.${pad2(mon)}.${pad2(lastDay)} 기준`;
}

/**
 * 바닥글의 연·월. `"2026년 09월"`.
 *
 * 바닥글은 연·월로 시작하고 그 뒤에 고정 문구가 붙는다. 뒤 문구는 **양식에 그대로
 * 두고** 파이썬이 앞의 연·월만 갈아끼운다(scripts/build_report.py 의
 * set_footer_month). 고객 문서의 문장을 우리 코드로 옮겨 오지 않으려는 것이다 —
 * 이 저장소는 공개다.
 */
export function footerMonthLabel(month: string): string {
  const { year, mon } = parseMonth(month);
  return `${year}년 ${pad2(mon)}월`;
}
