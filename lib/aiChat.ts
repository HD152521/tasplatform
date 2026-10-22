/**
 * LLM 호출 관문.
 *
 * 요약·리포트·답변요약이 부르는 단일 진입점이다. 우선순위:
 *   1) 설정된 LLM 연결(DB llm_connections, 없으면 LLM_* 환경변수) → 그 엔드포인트로 호출
 *   2) 없으면 OPENAI_API_KEY 폴백(기존 동작 보존)
 *   3) 둘 다 없으면 던진다(빈 문서를 성공으로 오해하지 않도록)
 *
 * 이렇게 두면 기존 호출부(summary·srReport·replySummary)는 import 만 이쪽으로 바꾸면
 * 코드 변경 없이 새 LLM 을 쓴다.
 *
 * server-only 를 붙이지 않는다. 수집기(Node)에서도 부른다. 뷰어(server-only) 진입점은
 * lib/ai.ts 다.
 */
import { openDb } from "./db.ts";
import { getLlmConfig } from "./llmConfig.ts";
import { chatOnceWithConfig, chatWithConfig, type ChatOptions } from "./llmClient.ts";
import {
  OpenAiError, chat as openaiChat, chatOnce as openaiChatOnce, hasOpenAi as hasOpenAiKey,
} from "./openaiClient.ts";
import { runWithContinuation, type ContinuationLimits } from "./chatContinue.ts";

// 기존 호출부가 catch(OpenAiError) / hasOpenAi() 를 쓰므로 그대로 재노출한다.
export { OpenAiError } from "./openaiClient.ts";
export type { ChatOptions } from "./llmClient.ts";

/**
 * `chat()` 이 던진 것을 사람이 읽을 한 줄로 바꾼다.
 *
 * ## 왜 필요한가
 *
 * `chat()` 은 **두 종류**를 던진다 — OpenAI 경로는 `OpenAiError`, 설정된 LLM 경로는
 * `LlmError`(lib/llmClient.ts)다. `OpenAiError` 만 잡고 나머지를 다시 던지면 사내 LLM
 * 쪽 실패가 전부 **HTTP 500** 이 되고, 화면에는 이유 없이 "500" 만 남는다. 실제로
 * /api/draft/quick 이 그렇게 나갔다.
 *
 * ## 왜 메시지를 다듬나
 *
 * 게이트웨이가 죽으면 nginx 가 **HTML 오류 페이지**를 돌려주고, 그게 그대로 메시지에
 * 실린다(`LlmError` 가 본문 앞 200자를 담는다). 화면에 `<html><head><title>500 …` 이
 * 뜨면 사람은 무엇이 문제인지 알 수 없다. 태그를 걷어내고 공백을 접는다.
 */
export function chatFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const text = raw
    .replace(/<[^>]*>/g, " ")   // HTML 오류 페이지의 태그
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return "LLM 호출이 실패했습니다.";
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * system + user 한 번 주고받기. 실패는 던진다.
 * 설정된 LLM 이 있으면 그쪽, 없으면 OpenAI 폴백.
 */
export async function chat(system: string, user: string, options: ChatOptions = {}): Promise<string> {
  const db = await openDb();
  let config;
  try {
    config = await getLlmConfig(db);
  } finally {
    await db.close();
  }

  if (config) return chatWithConfig(config, system, user, options);
  if (hasOpenAiKey()) return openaiChat(system, user, options);
  throw new OpenAiError(0, "LLM 연결이 설정되지 않았습니다 (설정 > LLM 또는 OPENAI_API_KEY).");
}

/**
 * 잘리면 **이어받아 가며** 한 덩이를 완성한다.
 *
 * 출력 상한(사내 엔드포인트 기본 512 토큰)에 걸려 문장 중간에서 끊긴 글이 그대로
 * 문서가 되는 것을 막는다. 잘렸는지는 응답의 `finish_reason` 으로 안다 — 길이로
 * 짐작하지 않는다(lib/chatContinue.ts).
 *
 * 백엔드는 `chat()` 과 같은 우선순위로 고르고, **한 번만 고른다** — 이어받을 때마다
 * DB 를 다시 열 이유가 없다.
 *
 * 끝까지 못 쓴 경우는 **로그로 남긴다.** 조용히 짧은 글을 돌려주면 상한 문제가 다시
 * 보이지 않게 된다 — 이 기능을 만든 이유가 그것이다.
 */
export async function chatLong(
  system: string,
  user: string,
  options: ChatOptions & ContinuationLimits = {},
): Promise<string> {
  const db = await openDb();
  let config;
  try {
    config = await getLlmConfig(db);
  } finally {
    await db.close();
  }

  const shared = { maxTokens: options.maxTokens, temperature: options.temperature };
  const withTimeout = (timeoutMs: number | undefined) =>
    timeoutMs === undefined ? shared : { ...shared, timeoutMs };

  const chosen = config;
  const call = chosen !== null
    ? (u: string, timeoutMs: number | undefined) =>
      chatOnceWithConfig(chosen, system, u, withTimeout(timeoutMs))
    : hasOpenAiKey()
      ? (u: string, timeoutMs: number | undefined) =>
        openaiChatOnce(system, u, withTimeout(timeoutMs))
      : null;
  if (call === null) {
    throw new OpenAiError(0, "LLM 연결이 설정되지 않았습니다 (설정 > LLM 또는 OPENAI_API_KEY).");
  }

  const outcome = await runWithContinuation(call, user, options);
  if (outcome.error !== undefined) {
    console.error(`[llm] 이어받기가 실패해 받은 만큼만 씁니다: ${outcome.error}`);
  } else if (outcome.truncated) {
    console.error(
      `[llm] 출력 상한에 걸려 끝까지 쓰지 못했습니다(호출 ${outcome.calls}회). `
      + "설정 > LLM 의 max_tokens 를 올리면 줄어듭니다.",
    );
  }
  return outcome.text;
}

/**
 * AI 를 쓸 수 있는지. 설정된 LLM 이 있거나 OPENAI_API_KEY 가 있으면 true.
 * (이름은 기존 호출부 호환을 위해 hasOpenAi 를 유지한다.)
 */
export async function hasOpenAi(): Promise<boolean> {
  const db = await openDb();
  try {
    if ((await getLlmConfig(db)) !== null) return true;
  } finally {
    await db.close();
  }
  return hasOpenAiKey();
}
