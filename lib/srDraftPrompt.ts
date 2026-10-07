/**
 * SR 작성 본문을 Broadcom 에 보낼 영문으로 정리하는 프롬프트.
 *
 * ⚠ 케이스 본문이 AI 로 나간다. lib/aiChat.ts 경유로만 부른다(사내 LLM 우선,
 *   없으면 OPENAI_API_KEY). lib/translate.ts(Gemini/Groq) 로는 절대 보내지 않는다 —
 *   그쪽 머리말의 경고 참고.
 *
 * 틀은 지어내지 않고 **우리가 실제로 올린 최근 120건에서 뽑았다**(2026-09-22 실측):
 *
 *   인사말로 시작        80%
 *   맺음말(Thanks 등)    79%
 *   버전·제품 언급       65%
 *   에러 문구 인용       49%
 *   섹션 제목 사용       22%   ← 대부분 안 쓴다
 *   번호 목록            17%
 *
 * 즉 지배적인 모양은 **인사말 → 제목 없는 줄글 문단 → 질문 → 맺음말** 이다.
 * 문단 수 중앙값은 7. 섹션 제목을 쓴 26건 중 15건이 Questions 계열이라,
 * 제목은 질문 묶음에만 붙인다. Background·Symptom 같은 제목은 쓰지 않는다
 * (Background 는 120건 중 1건뿐이었다).
 *
 * server-only 를 붙이지 않는다. 프롬프트와 파서는 순수 함수라 그대로 테스트한다.
 */

/**
 * 담당자가 적는 한국어 길이 상한.
 *
 * 실측 최초등록 본문 최대가 6,531자였다. 여유를 두고 그 두 배 가까이 잡는다.
 *
 * **두 라우트가 같이 쓴다**(/api/draft/compose, /api/draft/quick). 한때 각자 베껴
 * 두었는데, 한쪽만 바뀌면 사람이 같은 글을 넣고 한쪽에서는 거절당한다.
 */
export const DRAFT_CONTENT_LIMIT = 12_000;

/** 모델이 쓸 수 있는 유일한 섹션 제목. 질문이 있을 때만 붙인다. */
export const QUESTIONS_HEADING = "Questions";

/** 원문에 없어 채울 수 없는 자리. 지어내는 것보다 비워 두는 편이 낫다. */
export const UNKNOWN_MARK = "(to be confirmed)";

export const DRAFT_SYSTEM_PROMPT = [
  "당신은 VMware Tanzu / Cloud Foundry 를 운영하는 한국 기술지원팀의 엔지니어입니다.",
  "담당자가 한국어로 적은 내용을 Broadcom 지원팀에 보낼 영문 SR 본문으로 정리합니다.",
  "",
  "# 글의 모양",
  "우리 팀이 실제로 쓰는 모양을 그대로 따릅니다.",
  "- `Hello Support Team,` 로 시작합니다.",
  "- 본문은 **제목 없는 영어 문단**으로 씁니다. 운영 환경·제품 버전·증상·이미 해본 것을",
  "  문단 안에 자연스럽게 녹입니다. Background, Symptom, Environment 같은 소제목은",
  "  붙이지 않습니다.",
  `- 물어볼 것이 있으면 마지막 문단 뒤에 \`${QUESTIONS_HEADING}\` 한 줄을 두고 번호로 나열합니다.`,
  "  질문이 하나도 없으면 그 줄을 아예 쓰지 않습니다.",
  "- `Thanks,` 로 맺습니다.",
  "",
  "# 지켜야 할 것",
  "- **원문에 없는 사실을 지어내지 않습니다.** 버전·수치·에러 문구·발생 시각을 추측해서",
  `  채우지 않습니다. 꼭 필요한데 원문에 없으면 \`${UNKNOWN_MARK}\` 로 두고 넘어갑니다.`,
  "- 에러 문구·로그·명령어·경로·설정값은 **원문 그대로** 옮깁니다. 번역하거나 다듬지 않습니다.",
  "- 담당자가 쓴 요청 항목을 빼거나 뭉치지 않습니다. 질문 세 개면 세 개 그대로 둡니다.",
  "- 영어는 평이한 기술 문서체로 씁니다. 과장이나 사과를 덧붙이지 않습니다.",
  "- 고객사 이름은 쓰지 않습니다. 이미 계정으로 식별됩니다.",
  "",
  "# 출력 형식",
  "아래 세 덩어리만 이 순서로 출력합니다. 다른 말은 붙이지 않습니다.",
  "",
  "[SUBJECT]",
  "(영문 제목 한 줄.",
  " 제품·버전을 대괄호로 앞에 붙이는데, **주어진 것에서만** 가져옵니다 —",
  " 케이스 속성의 Prod Release, 또는 본문에 적힌 제품·버전. 예: [TPCF 10.4]",
  " 둘 다 없으면 **대괄호를 아예 쓰지 않습니다.** 제품명이나 버전을 추측해서 만들지",
  " 않습니다. 실제로 본문에 TPCF 10.4 라고 적혀 있는데 [TAS 2.3.4] 를 붙인 적이",
  " 있습니다 — 제품도 버전도 근거 없는 값이었습니다.)",
  "",
  "[CONTENT]",
  "(정리된 영문 본문 전체)",
  "",
  "[MISSING]",
  "(Broadcom 이 되물을 법한데 원문에 없는 정보를 한국어로 한 줄에 하나씩.",
  " 없으면 이 덩어리를 비워 둡니다.)",
].join("\n");

/**
 * 이미 영어로 적은 글을 **같은 언어 그대로** 팀 양식으로 다듬는다.
 *
 * 번역과 나눠 둔 이유는 섞이면 둘 다 나빠지기 때문이다. 번역 프롬프트로 영어를
 * 넣으면 모델이 "옮길 것이 없다" 고 보고 원문을 거의 그대로 뱉거나, 반대로
 * 한국어로 옮겨 버린다. 다듬기는 언어를 건드리지 말라고 따로 못박는다.
 */
export const TIDY_SYSTEM_PROMPT = [
  "당신은 VMware Tanzu / Cloud Foundry 를 운영하는 한국 기술지원팀의 엔지니어입니다.",
  "담당자가 **영어로** 적은 SR 본문을 팀 양식에 맞게 다듬습니다.",
  "",
  "# 가장 중요한 것",
  "- **언어를 바꾸지 않습니다.** 영어로 들어온 글은 영어로 나갑니다. 한국어로 옮기지 않습니다.",
  "- **내용을 바꾸지 않습니다.** 사실을 더하거나 빼거나 다른 말로 바꾸지 않습니다.",
  "  문장이 어색해도 뜻이 달라질 바에는 그대로 둡니다.",
  "",
  "# 하는 일",
  "- 우리 팀이 쓰는 모양으로 배치합니다.",
  "  `Hello Support Team,` 로 시작하고, 제목 없는 영어 문단으로 본문을 쓰고,",
  `  물어볼 것이 있으면 \`${QUESTIONS_HEADING}\` 한 줄 뒤에 번호로 나열하고, \`Thanks,\` 로 맺습니다.`,
  "  질문이 하나도 없으면 그 줄을 쓰지 않습니다.",
  "- Background, Symptom, Environment 같은 소제목은 붙이지 않습니다.",
  "- 흩어진 질문을 찾아 Questions 로 모읍니다. 질문 개수와 뜻은 그대로 둡니다.",
  "- 중복된 문장, 군더더기 인사, 깨진 줄바꿈을 정리합니다.",
  "- 에러 문구·로그·명령어·경로·설정값·제품 버전은 **한 글자도 바꾸지 않습니다.**",
  "",
  "# 출력 형식",
  "아래 세 덩어리만 이 순서로 출력합니다. 다른 말은 붙이지 않습니다.",
  "",
  "[SUBJECT]",
  "(영문 제목 한 줄.",
  " 제품·버전을 대괄호로 앞에 붙이는데, **주어진 것에서만** 가져옵니다 —",
  " 케이스 속성의 Prod Release, 또는 본문에 적힌 제품·버전. 예: [TPCF 10.4]",
  " 둘 다 없으면 **대괄호를 아예 쓰지 않습니다.** 제품명이나 버전을 추측해서 만들지",
  " 않습니다. 실제로 본문에 TPCF 10.4 라고 적혀 있는데 [TAS 2.3.4] 를 붙인 적이",
  " 있습니다 — 제품도 버전도 근거 없는 값이었습니다.)",
  "",
  "[CONTENT]",
  "(다듬은 영문 본문 전체)",
  "",
  "[MISSING]",
  "(Broadcom 이 되물을 법한데 원문에 없는 정보를 한국어로 한 줄에 하나씩.",
  " 없으면 이 덩어리를 비워 둡니다.)",
].join("\n");

/** 무엇을 시킬 것인가. */
export type DraftMode = "translate" | "tidy";

export function readMode(value: unknown): DraftMode {
  // 모르는 값이 오면 번역으로 둔다. 한국어를 영어로 못 바꿔 보내는 쪽이 더 나쁘다.
  return value === "tidy" ? "tidy" : "translate";
}

export function systemPromptFor(mode: DraftMode): string {
  return mode === "tidy" ? TIDY_SYSTEM_PROMPT : DRAFT_SYSTEM_PROMPT;
}

export interface DraftContext {
  /** 담당자가 적은 한국어 원문. */
  readonly content: string;
  readonly productName?: string;
  readonly componentName?: string;
  /** 예: "TPCF 10.4" */
  readonly release?: string;
  readonly severity?: string;
  /** 이미 적어 둔 제목. 있으면 모델이 건드리지 않는다. */
  readonly subject?: string;
  /** 번역인가 다듬기인가. 본문 라벨이 달라진다. */
  readonly mode?: DraftMode;
}

/** 모델에게 줄 사용자 메시지. 아는 값은 넘겨 주어 지어내지 않게 한다. */
export function buildDraftUser(ctx: DraftContext): string {
  const facts: string[] = [];
  const add = (label: string, value?: string): void => {
    const v = (value ?? "").trim();
    if (v !== "") facts.push(`${label}: ${v}`);
  };
  add("Product", ctx.productName);
  add("Component", ctx.componentName);
  add("Prod Release", ctx.release);
  add("Severity", ctx.severity);

  const parts = [
    facts.length > 0
      ? `[케이스 속성]\n${facts.join("\n")}`
      : "[케이스 속성]\n(없음 — 본문에서 확인되는 것만 씁니다)",
  ];

  const subject = (ctx.subject ?? "").trim();
  parts.push(
    subject === ""
      ? "[제목]\n(아직 없음 — 만들어 주세요)"
      : `[제목]\n${subject}\n(이미 정해진 제목입니다. 그대로 두세요.)`,
  );

  const label = ctx.mode === "tidy"
    ? "[담당자가 영어로 적은 내용 — 언어를 바꾸지 말고 다듬기만 하세요]"
    : "[담당자가 적은 내용]";
  parts.push(`${label}\n${ctx.content.trim()}`);
  return parts.join("\n\n");
}

export interface ComposedDraft {
  /** 영문 제목. 이미 있던 제목을 그대로 둔 경우도 여기에 담긴다. */
  subject: string;
  /** 등록될 영문 본문. */
  content: string;
  /** 원문에 없어 담당자가 채워야 할 것들. */
  missing: string[];
}

/**
 * 모델 응답에서 세 덩어리를 뽑는다.
 *
 * 형식 준수에 기대지 않는다. 표식을 못 찾으면 **전체를 본문으로 본다** —
 * 애써 만든 글을 형식 때문에 버리는 것이 가장 나쁘다.
 */
export function parseComposed(text: string): ComposedDraft {
  const clean = text.replace(/```[a-z]*\n?|```/gi, "").trim();
  const find = (name: string): number => {
    const m = new RegExp(`^\\s*\\[?${name}\\]?\\s*:?\\s*$`, "im").exec(clean);
    return m === null ? -1 : (m.index ?? -1) + m[0].length;
  };
  const starts = {
    subject: find("SUBJECT"),
    content: find("CONTENT"),
    missing: find("MISSING"),
  };

  // 표식이 하나도 없으면 전부 본문이다.
  if (starts.subject === -1 && starts.content === -1) {
    return { subject: "", content: clean, missing: [] };
  }

  /** from 에서 시작해, 뒤따르는 다른 표식 앞까지. */
  const slice = (from: number): string => {
    if (from === -1) return "";
    const after = Object.values(starts).filter((i) => i > from);
    const end = after.length > 0 ? Math.min(...after) : clean.length;
    // 다음 표식 줄 자체를 잘라낸다.
    const raw = clean.slice(from, end);
    return raw.replace(/\n\s*\[?(SUBJECT|CONTENT|MISSING)\]?\s*:?\s*$/i, "").trim();
  };

  const missing = slice(starts.missing)
    .split("\n")
    .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
    .filter((l) => l !== "" && !/^\(?(없음|none)\)?\.?$/i.test(l));

  return {
    // 제목이 여러 줄로 오면 첫 줄만 쓴다.
    subject: (slice(starts.subject).split("\n")[0] ?? "").trim(),
    content: slice(starts.content),
    missing,
  };
}

/* ------------------------------------------------------------------ *
 * 제목 앞 대괄호 검증
 * ------------------------------------------------------------------ */

/**
 * 제목 앞 대괄호가 근거 있는 값인지 보고, 아니면 떼어낸다.
 *
 * 프롬프트로만 막으면 또 샌다. 실제로 본문에 `TPCF 10.4` 라고 적혀 있는데
 * `[TAS 2.3.4]` 가 붙어 나온 일이 있었다 — 제품도 버전도 없는 값이다. 이 대괄호는
 * 담당자가 "어떤 제품·컴포넌트가 문제인지" 보고 적는 자리라, 틀린 값이 붙으면
 * Broadcom 쪽에서 케이스가 엉뚱한 팀으로 갈 수 있다.
 *
 * 판정은 단순하게 한다 — 대괄호 안의 낱말(2자 이상 영문, 또는 10.4 같은 숫자)이
 * **모두** 근거(케이스 속성 + 담당자가 적은 본문)에 있어야 남긴다. 하나라도 없으면
 * 대괄호 전체를 뗀다. 대괄호가 사라지는 것은 담당자가 눈으로 보고 채우면 되지만,
 * 없는 버전이 붙어 나가는 것은 돌이킬 수 없다.
 */
export function stripUngroundedTag(subject: string, facts: string): string {
  const match = /^\s*\[([^\]]{1,60})\]\s*/.exec(subject);
  if (match === null) return subject.trim();

  const tag = match[1] ?? "";
  // 영문 낱말(2자 이상)과 버전 숫자(10, 10.4, 2.3.4)만 본다. 구분기호는 무시한다.
  const tokens = tag.match(/[A-Za-z]{2,}|\d+(?:\.\d+)*/g) ?? [];
  const haystack = facts.toLowerCase();
  const grounded = tokens.length > 0
    && tokens.every((token) => haystack.includes(token.toLowerCase()));

  return grounded ? subject.trim() : subject.slice(match[0].length).trim();
}
