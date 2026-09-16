/**
 * 뷰어(서버 컴포넌트·라우트) 쪽 OpenAI 진입점.
 *
 * 구현은 lib/openaiClient.ts 에 있다. 수집기에서도 같은 호출부를 써야 하는데
 * server-only 가 붙은 모듈은 Node 스크립트에서 불러올 수 없어 갈라 두었다.
 * 이 파일은 가드레일만 담당한다 — 뷰어 코드는 계속 여기서 가져다 쓰면 된다.
 *
 * ⚠ 키 취급 주의사항은 lib/openaiClient.ts 머리말에 있다.
 */
import "server-only";

export { OpenAiError, chat, hasOpenAi } from "./openaiClient.ts";
