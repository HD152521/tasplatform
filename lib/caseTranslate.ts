/**
 * 케이스 대화를 한국어로 읽기 위한 번역.
 *
 * ⚠ 케이스 본문이 AI 로 나간다. lib/aiChat.ts 경유로만 부른다(사내 LLM 우선,
 *   없으면 OPENAI_API_KEY). **lib/translate.ts(Gemini/Groq)로는 절대 보내지 않는다** —
 *   그쪽 머리말이 "케이스 본문·답변은 절대 여기로 보내지 말 것" 이라고 못박고 있다.
 *   고객사(금융권) 인프라 구성이 들어 있고 무료 티어는 입력이 학습에 쓰일 수 있다.
 *
 * 방향은 영→한 하나뿐이다. 읽는 것이 목적이라 한 방향이면 충분하고 캐시도 절반이다.
 *
 * server-only 를 붙이지 않는다. 프롬프트와 판별은 순수 함수라 그대로 테스트한다.
 */

/** 번역 대상 종류. DB 의 text_translations.scope 값과 같다. */
export type TranslateScope = "thread" | "case_desc";

export const TRANSLATE_LANG = "ko";

export const TRANSLATE_SYSTEM_PROMPT = [
  "당신은 VMware Tanzu / Cloud Foundry 기술지원 문서를 한국어로 옮기는 번역가입니다.",
  "Broadcom 지원 케이스의 대화 한 건을 한국어로 옮깁니다.",
  "",
  "지켜야 할 것:",
  "- **그대로 옮깁니다.** 요약하거나 줄이거나 설명을 덧붙이지 않습니다.",
  "  문단과 줄바꿈, 목록의 순서와 개수를 원문 그대로 유지합니다.",
  "- 로그, 명령어, 코드, 파일 경로, URL, 설정값, 에러 문구, 제품·버전 이름은",
  "  **원문 그대로 둡니다.** 번역하지 않습니다.",
  "- 기술 용어는 업계에서 쓰는 한국어를 쓰되, 어색하면 영어를 그대로 둡니다.",
  "  (예: Diego cell, buildpack, foundation 은 그대로)",
  "- 인사말과 서명도 그대로 옮깁니다. 임의로 지우지 않습니다.",
  "- 원문에 없는 내용을 채우지 않습니다.",
  "",
  "번역문만 출력합니다. 머리말, 설명, 따옴표, 코드펜스를 붙이지 않습니다.",
].join("\n");

/** 한 번에 보낼 본문 길이 상한. 실측 최초등록 본문 최대가 6,531자였다. */
export const TRANSLATE_LIMIT = 20_000;

const HANGUL = /[가-힣]/g;
const NON_SPACE = /\S/g;

/**
 * 이미 한국어인가.
 *
 * Broadcom 답변 2,605건 중 379건(15%)에 한글이 섞여 있다 — APAC 한국인 엔지니어가
 * 쓴 것이다. 그런 글을 다시 번역하면 돈만 쓰고 원문이 뭉개진다.
 * 한글이 전체 글자의 이 비율을 넘으면 번역하지 않는다.
 */
export const KOREAN_RATIO = 0.2;

export function koreanRatio(text: string): number {
  const total = (text.match(NON_SPACE) ?? []).length;
  if (total === 0) return 0;
  return (text.match(HANGUL) ?? []).length / total;
}

/** 번역해야 하는 글인가. 빈 글과 이미 한국어인 글은 건너뛴다. */
export function needsTranslation(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  return koreanRatio(trimmed) < KOREAN_RATIO;
}

/** 모델이 머리말이나 코드펜스를 붙여 와도 본문만 남긴다. */
export function cleanTranslation(text: string): string {
  return text
    .replace(/^\s*```[a-z]*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .replace(/^\s*(번역(문|\s*결과)?|Translation)\s*[:：]\s*\n?/i, "")
    .trim();
}

/** 번역 한 건의 대상. scope·refId 는 text_translations 의 키와 같다. */
export interface TranslateTarget {
  readonly scope: TranslateScope;
  readonly refId: number;
  readonly text: string;
}

/** text_translations 한 행을 가리키는 키. 화면·API·DB 가 같은 문자열을 쓴다. */
export function translationKey(scope: string, refId: number): string {
  return `${scope}:${refId}`;
}

/**
 * 케이스 한 건에서 **번역할 수 있는** 글 목록.
 *
 * 한국어 원문과 빈 글은 애초에 담지 않는다. 화면(버튼을 낼지)과 API(무엇을 번역할지)가
 * 같은 판정을 써야 "버튼은 있는데 눌러도 400" 같은 어긋남이 생기지 않는다.
 *
 * 최초 등록 본문(case_desc)이 앞, 대화(thread)가 뒤다 — 화면에 보이는 순서와 같다.
 */
export function caseTranslateTargets(input: {
  requestId: number;
  descriptionText: string;
  threads: ReadonlyArray<{ threadId: number; bodyText: string }>;
}): TranslateTarget[] {
  const out: TranslateTarget[] = [];
  if (needsTranslation(input.descriptionText)) {
    out.push({ scope: "case_desc", refId: input.requestId, text: input.descriptionText });
  }
  for (const thread of input.threads) {
    if (needsTranslation(thread.bodyText)) {
      out.push({ scope: "thread", refId: thread.threadId, text: thread.bodyText });
    }
  }
  return out;
}

/**
 * 이미 저장된 번역을 뺀 나머지.
 *
 * 한 번 번역한 글은 다시 부르지 않는다 — AI 호출은 돈이 들고, 다시 부르면 같은 글의
 * 번역문이 미묘하게 달라져 읽는 사람이 헷갈린다. `have` 는 loadTranslations 가 돌려준
 * Map 을 그대로 받는다(키만 보므로 Set 도 받는다).
 */
export function untranslated(
  targets: readonly TranslateTarget[],
  have: { has(key: string): boolean },
): TranslateTarget[] {
  return targets.filter((t) => !have.has(translationKey(t.scope, t.refId)));
}

/**
 * 대상 목록에서 한 건만 고른다.
 *
 * 목록은 이 케이스의 글로만 만들어지므로, 여기서 못 찾으면 **다른 케이스의 번호이거나
 * 번역 대상이 아닌 글**이다. 즉 이 함수가 케이스 경계를 지키는 자리다.
 */
export function pickTarget(
  targets: readonly TranslateTarget[],
  scope: string,
  refId: number,
): TranslateTarget | null {
  return targets.find((t) => t.scope === scope && t.refId === refId) ?? null;
}

/** 요청으로 들어온 scope 문자열을 검사한다. 모르는 값은 null. */
export function asTranslateScope(value: string | null): TranslateScope | null {
  return value === "thread" || value === "case_desc" ? value : null;
}

export type TranslateControlKind = "korean" | "translate" | "toggle";

/**
 * 글 한 건 옆에 무엇을 보일지.
 *
 * 위쪽 "전체 번역" 과 글마다의 버튼이 **같은 사실**(저장된 번역이 있는지)을 보고
 * 판단하도록 이 함수 하나로 모았다. 전체 번역을 돌린 뒤에도 개별 버튼이 "번역" 으로
 * 남아 다시 부르게 되는 어긋남을 막는다.
 *
 * 한국어 원문인 글은 버튼을 숨기되 **왜 없는지**를 대신 적는다. 그냥 지우면
 * "왜 어떤 글엔 버튼이 없지" 가 되고, 흐린 버튼을 남기면 눌러도 안 되는 것이 놓인다.
 */
export function translateControl(state: {
  /** 원문이 영문이라 번역할 수 있는가(= caseTranslateTargets 에 들어갔는가). */
  translatable: boolean;
  /** 저장된 번역이 있는가. */
  hasTranslation: boolean;
  /** 지금 번역문을 보고 있는가. */
  showingKorean: boolean;
}): { kind: TranslateControlKind; label: string } {
  if (!state.translatable) return { kind: "korean", label: "원문이 한국어" };
  if (!state.hasTranslation) return { kind: "translate", label: "번역" };
  return state.showingKorean
    ? { kind: "toggle", label: "원문 보기" }
    : { kind: "toggle", label: "한국어 보기" };
}
