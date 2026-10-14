/**
 * 포털에 "이 세션 아직 살아 있나" 를 직접 물어본다.
 *
 * ## 왜 쿠키 만료 시각으로는 모르나
 *
 * 화면 왼쪽 아래의 "세션 연결됨" 은 세션 파일 쿠키의 **만료 시각**만 보고 그린다.
 * 그런데 계정 하나를 웹과 수집기가 같이 쓰기 때문에, 수집기가 재로그인하면 앞선
 * 세션이 **만료 시각 전에도** 서버 쪽에서 죽는다(lib/sessionStore.ts 머리말).
 * 쿠키는 여전히 미래 시각을 들고 있으니 화면은 "연결됨" 이라고 말한다 — **거짓말이다.**
 *
 * 그 거짓말의 대가가 큰 자리가 하나 있다. 사람이 5분 들여 답변을 쓰고 전송을 눌렀을
 * 때 비로소 세션이 죽은 걸 알게 되는 것이다. 쓰기 **전에** 알 수 있으면 먼저
 * 되살리고 쓴다.
 *
 * ## 왜 매 페이지에서 서버가 부르지 않나
 *
 * 포털 왕복은 실측 0.15~0.6초다. 레이아웃에서 부르면 **모든 페이지가** 그만큼 느려진다.
 * 그래서 이 함수는 전용 라우트에서만 쓰고, 화면은 그린 뒤에 따로 물어본다
 * (app/SessionDot.tsx).
 */
import { API_HEADERS, API_ORIGIN } from "./config.ts";
import type { ApiClient } from "../collector/httpClient.ts";

/**
 * 세션 상태.
 *
 * `unknown` 을 따로 두는 이유: 망이 끊기거나 포털이 5xx 를 주는 것은 **세션이 죽은
 * 것과 다르다.** 하나로 합치면 VPN 이 잠깐 끊겼을 때 "세션 없음" 이라고 말해 사람이
 * 엉뚱하게 재로그인을 하러 간다.
 */
export type SessionState = "alive" | "dead" | "unknown";

/** 세션이 살아 있는지 포털에 물어본다. 던지지 않는다. */
export async function probeSession(client: ApiClient): Promise<SessionState> {
  try {
    const response = await client.get(`${API_ORIGIN}/account_service/issessionvalid`, {
      headers: API_HEADERS,
    });
    const status = response.status();
    if (status === 200) return "alive";
    // 포털은 세션이 끊기면 401(가끔 403)을 준다. 그 밖의 상태는 판정하지 않는다.
    if (status === 401 || status === 403) return "dead";
    return "unknown";
  } catch {
    // 망 오류·타임아웃. 세션이 죽었다는 뜻이 아니다.
    return "unknown";
  }
}
