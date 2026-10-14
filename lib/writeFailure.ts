/**
 * 쓰기 실패를 사람이 읽을 한 줄로 바꾼다 — 순수 함수.
 *
 * ## 왜 따로 두나
 *
 * 세션 만료는 이 도구에서 **정상적으로 일어나는 실패**다. 계정 하나를 웹과 수집기가
 * 같이 쓰는데, 수집기가 재로그인하면 앞선 세션이 만료 시각 전에도 죽는다
 * (lib/sessionStore.ts 머리말). 라우트는 DB 백업으로 한 번 되살려 보지만, 그것까지
 * 낡았으면 사람에게 넘어온다.
 *
 * 그때 화면에 뜨던 말은 "세션이 만료되었습니다." 한 줄이었다. 그 말로는
 * **무엇을 해야 하는지도, 쓴 글이 남아 있는지도** 알 수 없다. 실제로 담당자는 글이
 * 날아갔다고 보고 다시 쓰기 시작했다. 지금은 초안을 브라우저에 붙잡아 두므로
 * (lib/draftStore.ts) 그 사실까지 같이 말해 준다.
 *
 * 세션과 **무관한** 실패에 이 안내를 붙이면 안 된다. 망 오류에까지 "로그인하세요" 가
 * 붙으면 엉뚱한 곳을 파게 된다 — app/api/reply/route.ts 가 한때 그래서 모든 실패를
 * 세션 만료로 보여 줬다. 그래서 `code` 를 보고만 붙인다.
 */

/** 세션이 끊긴 뒤 할 일. 두 경로 모두 적는다 — 쓰는 사람이 수집기 기계를 못 볼 수도 있다. */
const SESSION_HELP =
  "쓰던 글은 이 브라우저에 보관했습니다. 로그인 페이지에서 세션을 갱신하거나 " +
  "수집기에서 'npm run refresh' 를 돌린 뒤 이 화면으로 돌아오면 글이 그대로 남아 있습니다.";

/** 세션이 끊겨 실패한 것인가. 라우트가 code:"session" 으로 알려 준다. */
export function isSessionFailure(code: string | undefined): boolean {
  return code === "session";
}

/**
 * 실패 응답을 화면에 띄울 문장으로 바꾼다.
 *
 * `message` 가 비어 있으면 `fallback` 을 쓴다. 세션 만료일 때만 할 일을 덧붙인다.
 */
export function writeFailureText(
  data: { code?: string; message?: string },
  fallback: string,
): string {
  const head = (data.message ?? "").trim() === "" ? fallback : (data.message ?? "").trim();
  return isSessionFailure(data.code) ? `${head} ${SESSION_HELP}` : head;
}
