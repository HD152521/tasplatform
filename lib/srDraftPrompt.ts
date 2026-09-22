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
  "(영문 제목 한 줄. 제품·버전을 대괄호로 앞에 붙입니다. 예: [TPCF 10.4] ...)",
  "",
  "[CONTENT]",
  "(정리된 영문 본문 전체)",
  "",
  "[MISSING]",
  "(Broadcom 이 되물을 법한데 원문에 없는 정보를 한국어로 한 줄에 하나씩.",
  " 없으면 이 덩어리를 비워 둡니다.)",
].join("\n");

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

  parts.push(`[담당자가 적은 내용]\n${ctx.content.trim()}`);
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
