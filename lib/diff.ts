/**
 * 변경 감지.
 *
 * 설계 원칙: "답변을 놓치는 것"이 "알림이 한 번 더 오는 것"보다 훨씬 나쁘다.
 * 따라서 작성 주체를 확신할 수 없으면 우리 글이 아닌 것(=답변)으로 본다.
 */
import type { RequestThreadVo, SearchResultItem } from "./types.ts";

export interface CaseChange {
  item: SearchResultItem;
  reason: "new" | "updated";
}

/** DB에 없거나 lastUpdated 가 달라진 케이스만 골라낸다. */
export function selectChangedCases(
  fetched: readonly SearchResultItem[],
  known: ReadonlyMap<number, string>,
): CaseChange[] {
  const changes: CaseChange[] = [];
  for (const item of fetched) {
    const previous = known.get(item.requestId);
    if (previous === undefined) {
      changes.push({ item, reason: "new" });
    } else if (previous !== item.lastUpdated) {
      changes.push({ item, reason: "updated" });
    }
  }
  return changes;
}

/** 한 회차에 상태를 다시 확인할 상한. 한 건마다 상세 조회 한 번이 나간다. */
export const MAX_VANISHED_PER_RUN = 20;

/**
 * 조회 결과에서 **사라진** 진행중 케이스.
 *
 * 포털의 진행중 조회는 `End Customer Status != Closed` 로 거른다
 * (collector/payloads/search.json). 그래서 케이스가 닫히면 "상태가 Closed 로 바뀐 행"
 * 이 오는 게 아니라 **결과에서 빠진다.** 수집기는 조회로 받은 건만 쓰므로, 빠진 건은
 * 마지막으로 본 상태로 영영 굳는다 — 그러면 자동 게시 대상 조회
 * (`status IN ('closed','resolved')`, lib/autopublish.ts)에 영영 들어오지 않는다.
 *
 * 여기서는 **집기만** 한다. 사라졌다는 사실로 상태를 단정하지 않고, 호출부가 그 건의
 * 상세를 따로 조회해 실제 상태를 읽는다. 사라지는 이유가 종료만은 아니기 때문이다
 * (담당 이관·고객사 변경 등).
 *
 * **조회 결과가 비면 아무것도 집지 않는다.** 조회가 통째로 실패한 회차에 "전부
 * 사라졌다" 고 보면 살아 있는 케이스를 모두 닫아 버린다.
 */
export function selectVanishedCases(
  openIds: readonly number[],
  fetched: readonly Pick<SearchResultItem, "requestId">[],
  limit = MAX_VANISHED_PER_RUN,
): number[] {
  if (fetched.length === 0) return [];
  const seen = new Set(fetched.map((item) => item.requestId));
  const vanished: number[] = [];
  for (const id of new Set(openIds)) {
    if (seen.has(id)) continue;
    vanished.push(id);
    if (vanished.length >= limit) break;
  }
  return vanished;
}

/**
 * 이 스레드를 우리가 작성했는가?
 *  - creatorFlag 가 true면 케이스 생성자(=우리)
 *  - 작성 단위명에 broadcom 이 들어가면 상대 측
 *  - 판단 불가하면 false (= 답변으로 간주하여 알림을 놓치지 않는다)
 */
export function isOurThread(thread: Pick<RequestThreadVo, "creatorFlag" | "createdUserUnitName">): boolean {
  if (thread.creatorFlag === true) return true;
  const unit = (thread.createdUserUnitName ?? "").toLowerCase();
  if (unit.includes("broadcom")) return false;
  return false;
}

/** 아직 DB에 없는 스레드 중 상대 답변만 추린다. */
export function selectNewReplies(
  threads: readonly RequestThreadVo[],
  knownThreadIds: ReadonlySet<number>,
): RequestThreadVo[] {
  return threads.filter(
    (t) => !knownThreadIds.has(t.requestThreadId) && !isOurThread(t),
  );
}

/**
 * 포털이 같은 답변을 내부용/외부용 뷰로 각각 내려주는 경우가 있다.
 * (실측: 같은 케이스·같은 작성자·동일 본문이 8초 간격, HTML 길이만 다름)
 * DB에는 원본을 그대로 남기고, 알림 판정에서만 한 건으로 합친다.
 */
export const DUPLICATE_WINDOW_MS = 120_000;

export function dedupeReplies(threads: readonly RequestThreadVo[]): RequestThreadVo[] {
  const sorted = [...threads].sort((a, b) => (a.resDate ?? 0) - (b.resDate ?? 0));
  const kept: RequestThreadVo[] = [];

  for (const thread of sorted) {
    const body = htmlToText(thread.resDesc ?? "");
    const isDuplicate = kept.some(
      (seen) =>
        seen.requestId === thread.requestId &&
        htmlToText(seen.resDesc ?? "") === body &&
        Math.abs((seen.resDate ?? 0) - (thread.resDate ?? 0)) <= DUPLICATE_WINDOW_MS,
    );
    if (!isDuplicate) kept.push(thread);
  }
  return kept;
}

/** 아주 단순한 HTML -> 텍스트. 목록 미리보기와 검색용. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    // 블록 요소는 여닫기 모두 줄바꿈으로 바꿔야 문단 구분이 살아난다.
    .replace(/<\/?(p|div|li|ul|ol|tr|table|h[1-6]|blockquote|section)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    // 줄바꿈 주변 공백을 걷어내야 빈 줄 판정이 정확해진다.
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
