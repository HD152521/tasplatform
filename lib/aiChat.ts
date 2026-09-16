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
import { chatWithConfig, type ChatOptions } from "./llmClient.ts";
import { OpenAiError, chat as openaiChat, hasOpenAi as hasOpenAiKey } from "./openaiClient.ts";

// 기존 호출부가 catch(OpenAiError) / hasOpenAi() 를 쓰므로 그대로 재노출한다.
export { OpenAiError } from "./openaiClient.ts";
export type { ChatOptions } from "./llmClient.ts";

/**
 * system + user 한 번 주고받기. 실패는 던진다.
 * 설정된 LLM 이 있으면 그쪽, 없으면 OpenAI 폴백.
 */
export async function chat(system: string, user: string, options: ChatOptions = {}): Promise<string> {
  const db = openDb();
  let config;
  try {
    config = getLlmConfig(db);
  } finally {
    db.close();
  }

  if (config) return chatWithConfig(config, system, user, options);
  if (hasOpenAiKey()) return openaiChat(system, user, options);
  throw new OpenAiError(0, "LLM 연결이 설정되지 않았습니다 (설정 > LLM 또는 OPENAI_API_KEY).");
}

/**
 * AI 를 쓸 수 있는지. 설정된 LLM 이 있거나 OPENAI_API_KEY 가 있으면 true.
 * (이름은 기존 호출부 호환을 위해 hasOpenAi 를 유지한다.)
 */
export function hasOpenAi(): boolean {
  const db = openDb();
  try {
    if (getLlmConfig(db) !== null) return true;
  } finally {
    db.close();
  }
  return hasOpenAiKey();
}
