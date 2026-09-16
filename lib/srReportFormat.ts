/**
 * AI 가 만든 SR 보고서 텍스트를 슬라이드 칸으로 가른다.
 *
 * 모델에게 지시한 형식:
 *
 *   SR 제목
 *   - • {제목}
 *
 *   분석 및 진행상황
 *
 *   - 질의 내용
 *   {항목}
 *
 *   - 진행 상황
 *   {라벨}: {내용}
 *
 *   최종 결과
 *   - • {한 문장 요약}
 *
 * lib/srReport.ts 에서 분리한 이유는 lib/html.ts 와 같다 — server-only 모듈은
 * Node 에서 직접 import 할 수 없어 테스트가 안 된다.
 */

export interface SrReport {
  /** SR 제목 (슬라이드의 "SR 제목" 칸) */
  title: string;
  /** 질의 내용 + 진행 상황을 합친 것 (슬라이드의 "분석 및 진행 상황" 칸) */
  analysis: string;
  /** 최종 결과 한 문장 */
  result: string;
  /** 모델이 준 원문. 형식이 어긋났을 때 확인하려고 남긴다. */
  raw: string;
}

/** 줄머리의 "- ", "• ", "- • " 를 걷어낸다. */
function stripBullet(line: string): string {
  return line.replace(/^\s*[-•]\s*/, "").replace(/^\s*[-•]\s*/, "").trim();
}

/** 절 제목인가. 앞의 기호를 뗀 뒤 정확히 일치할 때만 참이다. */
function isHeading(line: string, heading: string): boolean {
  return stripBullet(line) === heading;
}

const HEADINGS = ["SR 제목", "분석 및 진행상황", "최종 결과"] as const;

/**
 * 절 단위로 자른다.
 *
 * 형식이 어긋나면 빈 문자열을 돌려주고 raw 를 남긴다 — 억지로 짜맞추면
 * 엉뚱한 내용이 슬라이드에 들어간다. 화면에서 원문을 보고 고칠 수 있게 한다.
 */
export function parseSrReport(text: string): SrReport {
  const raw = text.trim();
  const lines = raw.split("\n");

  const sections = new Map<string, string[]>();
  let current: string | null = null;

  for (const line of lines) {
    const matched = HEADINGS.find((h) => isHeading(line, h));
    if (matched !== undefined) {
      current = matched;
      sections.set(matched, []);
      continue;
    }
    if (current !== null) sections.get(current)?.push(line);
  }

  const take = (heading: string): string =>
    (sections.get(heading) ?? []).join("\n").trim();

  return {
    title: stripBullet(take("SR 제목").split("\n")[0] ?? ""),
    analysis: take("분석 및 진행상황"),
    result: stripBullet(take("최종 결과").split("\n").filter((l) => l.trim() !== "")[0] ?? ""),
    raw,
  };
}

/** 세 칸이 모두 채워졌는가. 하나라도 비면 화면에 경고를 띄운다. */
export function isComplete(report: SrReport): boolean {
  return report.title !== "" && report.analysis !== "" && report.result !== "";
}

/**
 * 케이스 본문과 답변을 모델에 넘길 한 덩어리 텍스트로 만든다.
 *
 * 원래 프롬프트는 PDF 를 넣는 전제였지만, 우리는 같은 내용을 이미 DB 에
 * 갖고 있으므로 텍스트로 넘긴다. PDF 로 바꿨다가 다시 읽는 과정이 없어
 * 오히려 손실이 적다.
 */
export function buildSourceText(input: {
  requestId: string;
  subject: string;
  status: string;
  priority: string;
  product: string;
  createdOn: string;
  closedOn: string;
  description: string;
  threads: ReadonlyArray<{ isOurs: boolean; at: string; body: string }>;
}): string {
  const parts: string[] = [
    `SR No.: ${input.requestId}`,
    `Subject: ${input.subject}`,
    `Product: ${input.product}`,
    `Severity: ${input.priority}`,
    `Status: ${input.status}`,
    `Opened: ${input.createdOn}`,
    `Closed: ${input.closedOn}`,
    "",
    "=== 최초 문의 내용 ===",
    input.description.trim() === "" ? "(없음)" : input.description.trim(),
    "",
    "=== 대응 경과 ===",
  ];

  for (const thread of input.threads) {
    parts.push("");
    parts.push(`--- ${thread.isOurs ? "고객사/당사" : "Broadcom TAC"} (${thread.at}) ---`);
    parts.push(thread.body.trim());
  }

  return parts.join("\n");
}

/* ------------------------------------------------------------------ *
 * 양식 표기 맞추기.
 *
 * 포털 값을 그대로 넣으면 기존 보고서와 표기가 달라진다.
 * 실제 8월 보고서는 심각도를 "2", 진행 상태를 "종료" 로 쓴다.
 * ------------------------------------------------------------------ */

/** "High - P2" → "2". 숫자를 못 찾으면 원문을 그대로 둔다. */
export function severityDigit(priority: string): string {
  const match = priority.match(/P?(\d)\s*$/);
  return match?.[1] ?? priority.trim();
}

const STATUS_LABELS: ReadonlyArray<[RegExp, string]> = [
  [/^closed$/i, "종료"],
  [/^resolved$/i, "종료"],
  [/^cancell?ed$/i, "취소"],
  [/pending\s*customer/i, "고객 확인"],
  [/pending/i, "대기"],
  [/^open$/i, "진행중"],
  [/in\s*progress/i, "진행중"],
];

/** 포털 상태를 보고서 표기로. 모르는 값은 그대로 둔다 — 지어내지 않는다. */
export function statusLabel(status: string): string {
  const value = status.trim();
  for (const [pattern, label] of STATUS_LABELS) {
    if (pattern.test(value)) return label;
  }
  return value;
}

/**
 * AI 출력을 양식 표기에 맞춘다.
 *
 * 모델은 "- 질의 내용" 처럼 글머리 기호를 붙이고 항목 사이에 빈 줄을 넣는다.
 * 실제 8월 보고서를 열어 보면 기호도 빈 줄도 없다:
 *
 *   질의 내용
 *   업그레이드 직후부터 ...
 *   해당 릴리스에서 ...
 *   진행 상황
 *   현상 파악: ...
 *
 * 그 형태로 맞춘다. 내용은 건드리지 않고 껍데기만 정리한다.
 */
export function normalizeAnalysis(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*[-•*]\s+/, "").trimEnd())
    .filter((line) => line.trim() !== "")
    .join("\n");
}
