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
