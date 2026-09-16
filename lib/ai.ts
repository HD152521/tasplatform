/**
 * 뷰어(서버 컴포넌트·라우트) 쪽 LLM 진입점.
 *
 * 구현은 lib/aiChat.ts 에 있다. 수집기에서도 같은 관문을 써야 하는데 server-only 가 붙은
 * 모듈은 Node 스크립트에서 불러올 수 없어 갈라 두었다(기존 openai.ts/openaiClient.ts 와 같은 구조).
 * 뷰어 코드는 여기서 chat 을 가져다 쓴다.
 */
import "server-only";

export { OpenAiError, chat, hasOpenAi } from "./aiChat.ts";
export type { ChatOptions } from "./aiChat.ts";
