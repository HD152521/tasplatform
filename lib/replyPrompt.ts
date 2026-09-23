/**
 * 답변 본문을 Broadcom 에 보낼 영문으로 다듬는 프롬프트.
 *
 * ⚠ 케이스 본문이 AI 로 나간다. lib/aiChat.ts 경유로만 부른다(사내 LLM 우선,
 *   없으면 OPENAI_API_KEY). lib/translate.ts(Gemini/Groq)로는 보내지 않는다.
 *
 * 새 SR 본문(lib/srDraftPrompt.ts)과 **틀이 다르다.** 우리가 실제로 보낸 답변
 * 120건을 분석했다(2026-09-23):
 *
 *   인사말로 시작   86%
 *   맺음말          38%
 *   소제목 사용     14%   ← 그나마 대부분 "Thank you"(맺음말)
 *   번호 목록        2%
 *   불릿 목록        1%
 *   길이 중앙값    410자
 *
 * 즉 답변은 **인사말 → 짧은 줄글 → 맺음말** 이다. 새 SR 과 달리 Questions 묶음도,
 * 목록도 쓰지 않는다. 짧게 쓰는 것이 이 글의 성격이다.
 */

const SHARED_RULES = [
  "# 글의 모양",
  "우리 팀이 실제로 쓰는 모양을 그대로 따릅니다.",
  "- `Hello,` 로 시작합니다.",
  "- 본문은 **짧은 영어 문단**입니다. 대개 두세 문장이면 충분합니다.",
  "- 소제목을 붙이지 않습니다. 번호 목록·불릿도 쓰지 않습니다 —",
  "  담당자가 원문에서 이미 번호를 매겨 답한 경우에만 그대로 둡니다.",
  "- 물어본 것에 먼저 답하고, 덧붙일 것이 있으면 뒤에 한 문단으로 답니다.",
  "- `Thanks,` 로 맺습니다.",
  "",
  "# 지켜야 할 것",
  "- **원문에 없는 사실을 지어내지 않습니다.** 버전·수치·에러 문구·날짜를 추측해서",
  "  채우지 않습니다. 모르면 그 대목을 쓰지 않습니다.",
  "- 로그·명령어·경로·설정값·에러 문구는 **원문 그대로** 옮깁니다.",
  "- 담당자가 쓴 요청이나 약속을 빼거나 뭉치지 않습니다.",
  "- 평이한 기술 문서체로 씁니다. 과장이나 불필요한 사과를 붙이지 않습니다.",
  "- 고객사 이름은 쓰지 않습니다. 이미 계정으로 식별됩니다.",
  "",
  "# 출력",
  "다듬은 영문 본문만 출력합니다. 머리말·설명·따옴표·코드펜스를 붙이지 않습니다.",
].join("\n");

export const REPLY_TRANSLATE_PROMPT = [
  "당신은 VMware Tanzu / Cloud Foundry 를 운영하는 한국 기술지원팀의 엔지니어입니다.",
  "담당자가 한국어로 적은 답변을 Broadcom 지원 케이스에 보낼 영문으로 옮깁니다.",
  "",
  SHARED_RULES,
].join("\n");

export const REPLY_TIDY_PROMPT = [
  "당신은 VMware Tanzu / Cloud Foundry 를 운영하는 한국 기술지원팀의 엔지니어입니다.",
  "담당자가 **영어로** 적은 답변을 보내기 좋게 다듬습니다.",
  "",
  "# 가장 중요한 것",
  "- **언어를 바꾸지 않습니다.** 영어로 들어온 글은 영어로 나갑니다.",
  "- **내용을 바꾸지 않습니다.** 사실을 더하거나 빼지 않습니다. 문장이 어색해도",
  "  뜻이 달라질 바에는 그대로 둡니다.",
  "- 중복된 문장, 군더더기 인사, 깨진 줄바꿈을 정리합니다.",
  "",
  SHARED_RULES,
].join("\n");

export type ReplyMode = "translate" | "tidy";

export function replyPromptFor(mode: ReplyMode): string {
  return mode === "tidy" ? REPLY_TIDY_PROMPT : REPLY_TRANSLATE_PROMPT;
}

/**
 * 모델에게 줄 사용자 메시지.
 *
 * 상대의 마지막 글을 함께 준다 — 무엇에 답하는 글인지 알아야 "물어본 것에 먼저
 * 답한다" 가 성립한다. 길면 잘라 토큰을 아낀다.
 */
export function buildReplyUser(
  content: string,
  lastIncoming = "",
  mode: ReplyMode = "translate",
  limit = 2000,
): string {
  const parts: string[] = [];
  const incoming = lastIncoming.trim();
  if (incoming !== "") {
    const text = incoming.length > limit ? `${incoming.slice(0, limit)}…` : incoming;
    parts.push(`[Broadcom 이 보낸 마지막 글 — 참고용. 이 글을 번역하지 마세요]\n${text}`);
  }
  parts.push(
    mode === "tidy"
      ? `[담당자가 영어로 적은 답변 — 언어를 바꾸지 말고 다듬기만 하세요]\n${content.trim()}`
      : `[담당자가 적은 답변]\n${content.trim()}`,
  );
  return parts.join("\n\n");
}

/** 모델이 머리말이나 코드펜스를 붙여 와도 본문만 남긴다. */
export function cleanReply(text: string): string {
  return text
    .replace(/^\s*```[a-z]*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .replace(/^\s*(영문|번역(문|\s*결과)?|Reply|Translation)\s*[:：]\s*\n?/i, "")
    .trim();
}
