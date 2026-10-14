/**
 * 쓰던 글을 브라우저에 붙잡아 둔다.
 *
 * ## 왜 필요한가
 *
 * 긴 글을 쓰고 보내면 "세션이 만료되었습니다" 가 뜨는 일이 있다. 공용 계정 하나를
 * 웹과 수집기가 같이 쓰는데, 수집기가 재로그인하면 **만료 시각 전에도** 앞 세션이
 * 죽기 때문이다(lib/sessionStore.ts 머리말).
 *
 * 그때 글 자체는 입력칸에 남는다. 문제는 그다음이다 — 세션을 고치려면 다른 기계에서
 * `npm run refresh` 를 해야 하고, 그 사이 새로고침하거나 창을 닫으면 **쓴 글이 사라진다.**
 * 5분 쓴 답변을 다시 쓰는 것이 이 도구를 쓰는 이유를 지운다.
 *
 * ## 왜 서버에 두지 않나
 *
 * 초안은 **아직 아무에게도 보여 줄 것이 아니다.** 서버에 두면 DB에 남고, 공용 계정이라
 * 남의 미완성 글이 보인다. 브라우저에만 두면 그 사람 기계를 벗어나지 않는다.
 *
 * ## 규칙
 *
 * - 저장은 **실패해도 조용히 넘긴다.** 시크릿 창이나 저장 차단 설정에서 localStorage
 *   접근 자체가 던진다. 초안 보존이 글쓰기를 막으면 안 된다.
 * - 보낸 뒤에는 **반드시 지운다.** 남겨 두면 다음에 열 때 이미 보낸 글이 되살아나,
 *   같은 답변을 두 번 보내게 된다.
 * - 빈 글은 저장하지 않는다(지운다). 빈 값을 남기면 "복구할 초안이 있다" 고 오해한다.
 */

/** 키 앞가지. 다른 앱과 섞이지 않게. */
const PREFIX = "sr-draft:";

/** 너무 큰 글은 담지 않는다. localStorage 는 보통 5MB 공용이라 한 글이 다 쓰면 안 된다. */
const MAX_CHARS = 100_000;

/**
 * 초안 하나를 가리키는 키.
 *
 * `kind` 는 쓰는 자리(답변·SR 작성 등), `id` 는 그 안에서의 대상(케이스 번호 등)이다.
 * 케이스마다 따로 보존해야 한다 — 한 칸으로 쓰면 다른 케이스를 열었을 때 남의 글이 뜬다.
 */
export function draftKey(kind: string, id: string | number = ""): string {
  return `${PREFIX}${kind}:${id}`;
}

/** 초안을 저장한다. 빈 글이면 지운다. 실패는 조용히 넘긴다. */
export function saveDraft(key: string, text: string): void {
  try {
    if (text.trim() === "") {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, text.slice(0, MAX_CHARS));
  } catch {
    // 저장이 막힌 환경(시크릿 창 등). 초안 보존이 글쓰기를 막으면 안 된다.
  }
}

/** 저장해 둔 초안. 없거나 읽을 수 없으면 빈 문자열. */
export function loadDraft(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** 보낸 뒤 지운다. 안 지우면 보낸 글이 다음에 되살아난다. */
export function clearDraft(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 위와 같은 이유.
  }
}
