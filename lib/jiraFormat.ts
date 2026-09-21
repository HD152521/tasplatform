/**
 * Jira 이슈를 보고서 표의 값으로 바꾸는 순수 함수들.
 *
 * lib/jira.ts 에서 분리해 둔 이유는 lib/html.ts 와 같다 — server-only 가 붙은
 * 모듈은 Node 에서 직접 import 할 수 없어 테스트가 안 된다.
 *
 * 날짜는 'YYYY-MM-DD' 문자열로 다룬다. ms 로 바꾸면 Jira 가 주는 +0900 이
 * UTC 로 접히면서 밤에 만든 이슈가 하루 앞으로 밀린다.
 * 문자열 사전순 비교가 곧 날짜순이라 그대로 최소·최대를 구할 수 있다.
 */

/**
 * 제목 앞 대괄호를 전산센터로 떼어낸다.
 *
 *   "[개발]Internal 통신 지연 원인 분석"    → 개발 / Internal 통신 지연 원인 분석
 *   "[개발/운영/DR] 업그레이드"             → 개발/운영/DR / 업그레이드
 *   "대괄호 없는 제목"                       → "" / 대괄호 없는 제목
 */
export function parseCenter(summary: string): { center: string; title: string } {
  const match = summary.match(/^\s*\[([^\]]*)\]\s*(.*)$/s);
  if (match === null) return { center: "", title: summary.trim() };
  return { center: (match[1] ?? "").trim(), title: (match[2] ?? "").trim() };
}

/**
 * 전산센터가 본사인가. 본사 업무는 보고서에 넣지 않는다.
 *
 * 상위 에픽만 보면 놓친다 — 제목이 "[본사]" 인데 상위가 은행 쪽 작업인 경우가 있다
 * (NHTAS-172 [본사]BOSH Tile 속성 테스트 → 상위 [검증]BOSH-Agent 재기동 여부 테스트).
 * 제목이 본사라고 말하면 본사로 본다.
 *
 * "개발/운영/DR" 처럼 여러 개일 수 있어 하나라도 본사면 제외한다.
 */
export function isHeadOffice(center: string): boolean {
  return center.split("/").some((part) => part.trim() === "본사");
}

/** 'YYYY-MM-DD' 를 'MM/DD' 로. */
function shortDate(date: string): string {
  const [, m, d] = date.slice(0, 10).split("-");
  return m === undefined || d === undefined ? date.slice(0, 10) : `${m}/${d}`;
}

/** ISO 문자열에서 날짜만 뗀다. Jira 가 준 +0900 표기를 그대로 존중한다. */
export function dateOf(iso: string | null): string | null {
  if (iso === null || iso === "") return null;
  return iso.slice(0, 10);
}

/**
 * 작업일 표기. 생성일 ~ 종료일이되,
 *   같은 날이면 한 날짜로 접고,
 *   아직 안 끝났으면 뒤를 비워 진행 중임을 드러낸다.
 */
export function spanLabel(startDate: string, endDate: string | null): string {
  const start = shortDate(startDate);
  if (endDate === null || endDate === "") return `${start} –`;
  const end = shortDate(endDate);
  return start === end ? start : `${start} – ${end}`;
}

/* ------------------------------------------------------------------ *
 * 같은 작업을 전산센터·법인별로 따로 올린 이슈들을 한 줄로 합친다.
 *
 * 보고서 규칙: 작업 내역이 같으면 묶되, 두 축(법인·전산센터) 중 한쪽만 여러 개여야 한다.
 *   법인 하나 + 센터 여럿 → 한 줄 (센터를 나열)
 *   센터 하나 + 법인 여럿 → 한 줄 (법인을 나열)
 *   둘 다 여럿          → 어느 센터가 어느 법인 것인지 구분이 안 된다. 법인별로 나눈다.
 *
 * 실제 보고서(6월)에 세 경우가 다 있다.
 *   개발        | 은행·중앙회 | LDAP 패스워드 변경 작업   ← 센터 하나, 법인 둘
 *   운영·DR      | 중앙회      | LDAP 패스워드 변경 작업   ← 둘 다 여럿이라
 *   운영·DR·AWS  | 은행        | LDAP 패스워드 변경 작업      법인 기준으로 갈렸다
 *
 * 작업일은 포괄 범위로 잡는다 — 1~3 과 2~4 가 있으면 1~4.
 * ------------------------------------------------------------------ */

export interface Mergeable {
  title: string;
  corp: string;
  center: string;
  /** 'YYYY-MM-DD' */
  startDate: string;
  /** 'YYYY-MM-DD', 미종료면 null */
  endDate: string | null;
}

/** 합칠 대상인지 가르는 기준: 법인 + 작업 내역. 법인별로 나눌 때 쓴다. */
export function mergeKey(row: { corp: string; title: string }): string {
  return `${row.corp} ${row.title.trim()}`;
}

/** 작업 내역만으로 만든 1차 묶음 키. 법인·센터는 그 안에서 따로 가른다. */
export function titleKey(row: { title: string }): string {
  return row.title.trim();
}

/** 합쳐진 값을 잇는 구분자. 실제 보고서가 한 칸 안에서 문단을 나눠 쓴다. */
const JOIN = "\n";

/**
 * 한 칸에 든 값을 낱개로 푼다.
 *
 * 원본이 "개발/운영" 일 수 있고, 이미 합쳐진 값(줄바꿈)이나 옛 표기(쉼표)가 다시
 * 들어올 수도 있다. 셋 다 같은 구분자로 본다.
 */
function splitLabel(raw: string): string[] {
  return raw.split(/[,/\n]/).map((p) => p.trim()).filter((p) => p !== "");
}

/**
 * 여러 값을 순서 유지하며 중복 없이 합친다(전산센터·법인 공용).
 *
 * 줄바꿈으로 잇는 이유는 실제 보고서가 그렇기 때문이다 — 6월 보고서의 "운영DR" 칸은
 * 사실 문단 두 개("운영", "DR")였다. scripts/build_report.py 가 줄바꿈을 문단
 * 경계로 삼아(87행) 그대로 그려 준다.
 */
function mergeLabels(values: readonly string[]): string {
  const seen: string[] = [];
  for (const raw of values) {
    for (const value of splitLabel(raw)) {
      if (!seen.includes(value)) seen.push(value);
    }
  }
  return seen.join(JOIN);
}

/** 전산센터를 순서 유지하며 중복 없이 합친다. */
export function mergeCenters(centers: readonly string[]): string {
  return mergeLabels(centers);
}

/** 법인을 순서 유지하며 중복 없이 합친다. 전산센터가 하나뿐일 때만 쓴다. */
export function mergeCorps(corps: readonly string[]): string {
  return mergeLabels(corps);
}

/** 이 묶음에 든 서로 다른 전산센터 수. 1 이면 법인을 합쳐도 어디 것인지 흐려지지 않는다. */
export function distinctCenterCount(rows: ReadonlyArray<{ center: string }>): number {
  const merged = mergeLabels(rows.map((r) => r.center));
  return merged === "" ? 0 : merged.split(JOIN).length;
}

/**
 * 여러 기간을 하나로 덮는 범위.
 *
 * 하나라도 안 끝났으면 끝을 비운다 — 끝나지 않은 작업이 섞여 있는데
 * 끝난 것처럼 보이게 하면 안 된다.
 */
export function mergeSpan(
  parts: ReadonlyArray<{ startDate: string; endDate: string | null }>,
): { startDate: string; endDate: string | null } {
  const starts = parts.map((p) => p.startDate).sort();
  const startDate = starts[0] ?? "";
  if (parts.some((p) => p.endDate === null || p.endDate === "")) {
    return { startDate, endDate: null };
  }
  const ends = parts.map((p) => p.endDate ?? "").sort();
  return { startDate, endDate: ends[ends.length - 1] ?? null };
}

/**
 * 합치기 실행. 원래 순서(작업 내역 첫 등장 순, 그 안에서 법인 첫 등장 순)를 지킨다.
 *
 * 합쳐진 결과는 T 를 그대로 두고 corp·center·startDate·endDate 만 갱신한다.
 * parts 에 원본 줄들을 담아 둔다 — 합쳐진 뒤에는 corp 가 "은행,중앙회" 가 될 수 있어
 * 부르는 쪽이 키로 되짚을 수 없기 때문이다.
 */
export function mergeRows<T extends Mergeable>(
  rows: readonly T[],
): Array<T & { merged: number; parts: T[] }> {
  // 1) 작업 내역으로 먼저 모은다. 법인·센터는 그 안에서 가른다.
  const byTitle = new Map<string, T[]>();
  const order: string[] = [];
  for (const row of rows) {
    const key = titleKey(row);
    const bucket = byTitle.get(key);
    if (bucket === undefined) {
      byTitle.set(key, [row]);
      order.push(key);
    } else {
      bucket.push(row);
    }
  }

  const out: Array<T & { merged: number; parts: T[] }> = [];
  const emit = (bucket: T[], corp: string): void => {
    if (bucket.length === 0) return;
    const first = bucket[0] as T;
    const span = mergeSpan(bucket);
    out.push({
      ...first,
      corp,
      center: mergeCenters(bucket.map((r) => r.center)),
      startDate: span.startDate,
      endDate: span.endDate,
      merged: bucket.length,
      parts: bucket,
    });
  };

  for (const key of order) {
    const bucket = byTitle.get(key) ?? [];

    // 2) 전산센터가 하나뿐이면 법인을 합쳐 한 줄로 낸다.
    if (distinctCenterCount(bucket) <= 1) {
      emit(bucket, mergeCorps(bucket.map((r) => r.corp)));
      continue;
    }

    // 3) 센터가 여럿이면 법인별로 나눈다. 둘 다 여럿이면 어느 센터가 어느 법인 것인지
    //    알 수 없어서다. 법인을 고정하면 센터 나열이 그 법인 것으로 읽힌다.
    const byCorp = new Map<string, T[]>();
    const corpOrder: string[] = [];
    for (const row of bucket) {
      const corpBucket = byCorp.get(row.corp);
      if (corpBucket === undefined) {
        byCorp.set(row.corp, [row]);
        corpOrder.push(row.corp);
      } else {
        corpBucket.push(row);
      }
    }
    for (const corp of corpOrder) emit(byCorp.get(corp) ?? [], corp);
  }

  return out;
}

/**
 * 이슈 상태를 보고서 "비고" 표기로.
 *
 * Jira 는 끝난 일을 "완료" 와 "해결됨" 두 가지로 쓰는데,
 * 보고서에서는 구분하지 않고 둘 다 "완료" 로 적는다.
 * 모르는 상태는 그대로 둔다 — 임의로 바꾸면 사실이 왜곡된다.
 */
const WORK_STATUS: ReadonlyArray<[RegExp, string]> = [
  [/^(완료|해결됨|종료)$/, "완료"],
  [/^(done|resolved|closed)$/i, "완료"],
  [/^(진행\s*중)$/, "진행중"],
  [/in\s*progress/i, "진행중"],
];

export function workStatusLabel(status: string): string {
  const value = status.trim();
  for (const [pattern, label] of WORK_STATUS) {
    if (pattern.test(value)) return label;
  }
  return value;
}
