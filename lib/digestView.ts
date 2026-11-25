/**
 * 서버가 보낸 주간 정리를 **화면이 쓸 수 있는 모양으로 확정한다.**
 *
 * ## 왜 따로 두나
 *
 * 이 자리에서 대시보드를 두 번 날렸다.
 *
 *   1. 화면이 `{ content }` 를 기대했는데 서버는 `{ body }` 를 보냈다 →
 *      `undefined.split()` 이 터지고 대시보드가 통째로 "Application error" 가 됐다.
 *      정리가 **없는 동안은 멀쩡했으니** 원인을 찾기 가장 어려운 모양이었다.
 *   2. 타입을 `import type` 으로 맞춰 1번을 막았지만, `as` 는 **거짓말을 한다** —
 *      JSON 응답을 `as WeeklyDigest` 로 적어도 런타임에 그 모양인지 아무도 확인하지
 *      않는다. 옛 빌드·옛 행·반쯤 채워진 행 하나가 그대로 같은 사고를 만든다.
 *
 * 그래서 **들어오는 경계에서 한 번** 확정한다. 여기를 지난 값은 `lines` 가 반드시
 * 배열이고 `createdAt` 이 반드시 문자열이라, 화면 코드가 터질 자리가 없다.
 *
 * 모르는 값은 **버리지 않고 비워 둔다** — 정리 본문이 비어도 "언제 만들었나" 는
 * 보여줄 값이 있고, 반대도 마찬가지다. 한 칸이 비어서 카드 전체를 숨기면 사람은
 * 정리가 없는 줄 안다.
 */

/** 어느 LLM 으로도 만들지 못했으면 "rule" 이다. 화면이 그대로 보여 준다. */
export type DigestSourceView = "llm" | "rule";

export interface DigestView {
  readonly week: string;
  readonly body: string;
  /** `body` 를 줄로 쪼갠 것. 줄바꿈이 뜻을 가진 글이라 문단으로 뭉개지 않는다. */
  readonly lines: readonly string[];
  readonly source: DigestSourceView;
  /** ISO 문자열. 모르면 빈 문자열 — **그럴듯한 시각을 만들어 넣지 않는다.** */
  readonly createdAt: string;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * JSON 으로 받은 것을 화면이 쓸 모양으로 확정한다. 모양이 아니면 `null`.
 *
 * `null` 과 "빈 정리" 를 가른다 — `null` 은 "아직 없다"(만들기 버튼을 보여 준다),
 * 빈 본문은 "만들었는데 쓸 내용이 없었다" 다. 둘을 합치면 사람이 버튼을 눌러도
 * 아무 변화가 없어 고장처럼 보인다.
 */
export function asDigestView(raw: unknown): DigestView | null {
  if (raw === null || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const body = textOf(row.body);
  return {
    week: textOf(row.week),
    body,
    // 빈 본문은 빈 배열이다. `"".split("\n")` 은 `[""]` 라서 빈 줄 하나가 생긴다.
    lines: body === "" ? [] : body.split("\n"),
    source: row.source === "llm" ? "llm" : "rule",
    createdAt: textOf(row.created_at ?? row.createdAt),
  };
}

/**
 * 만든 시각을 사람이 읽을 한 줄로. 모르면 빈 문자열(자리를 비워 둔다).
 *
 * `slice(0, 16).replace("T", " ")` 를 쓰던 자리다. 문자열이 아니면 그 한 줄이 터졌고,
 * 터지는 곳이 화면 한가운데라 카드가 아니라 **페이지 전체**가 날아갔다.
 */
export function stampText(createdAt: string): string {
  if (createdAt.length < 16) return createdAt;
  return createdAt.slice(0, 16).replace("T", " ");
}
