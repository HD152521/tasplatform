/**
 * 첨부 처리용 세션 상태 — **쿠키만 남기고 origins 를 버린다.**
 *
 * ## 왜 버리나
 *
 * Playwright 의 `storageState` 에 origins(localStorage)가 있으면 컨텍스트를 만들 때
 * **origin 마다 실제로 그 사이트를 방문해** localStorage 를 심는다. 우리 세션에는
 * origin 이 둘(포털·access.broadcom)이라 컨텍스트 생성에만 11.6초가 든다(실측).
 * 첨부 한 건의 고정 오버헤드가 30초쯤인데 그 3분의 1이 여기였다.
 *
 * 첨부 처리는 그 localStorage 가 필요 없다. 거기 담긴 것은 **기기 신뢰 표식**이고
 * (`_ia01`, 기기 지문) 오직 **로그인할 때** OTP 를 건너뛰는 데 쓰인다
 * (lib/browserIdentity.ts). 첨부는 로그인을 하지 않는다 — 이미 있는 세션 쿠키로
 * supportftp 에 들어가기만 한다.
 *
 * ## 왜 따로 떼어 두나
 *
 * 이 판단이 틀리면 첨부가 전부 "세션이 없습니다" 로 실패한다. 수집기 안에 묻어 두면
 * 실제로 돌려 보기 전까지 확인할 방법이 없다. 그래서 **쿠키를 고르는 규칙만** 떼어
 * 단위테스트로 잠근다. 파일 읽기는 부르는 쪽이 한다.
 *
 * 되돌릴 길도 남겨 둔다 — `SR_ATTACH_FULL_SESSION=1` 이면 수집기가 이 함수를 아예
 * 부르지 않고 세션 파일을 그대로 Playwright 에 넘긴다(collector/attachments.ts).
 */

/** Playwright 가 받는 storageState 의 최소 모양. 쿠키의 내용은 들여다보지 않는다. */
export interface CookiesOnlyState {
  readonly cookies: readonly unknown[];
  readonly origins: readonly never[];
}

/**
 * 세션 파일 내용(JSON 문자열)에서 쿠키만 남긴 상태를 만든다.
 *
 * 쿠키를 못 찾으면 **null** 이다. 그때 부르는 쪽은 세션 파일 경로를 그대로 Playwright 에
 * 넘긴다 — 여기서 빈 쿠키 목록을 돌려주면 "세션이 없다" 는 엉뚱한 실패가 되고, 사람은
 * 로그인을 의심한다. 모르면 손대지 않는 편이 낫다.
 */
export function cookiesOnlyState(json: string): CookiesOnlyState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const cookies = (parsed as { cookies?: unknown }).cookies;
  if (!Array.isArray(cookies) || cookies.length === 0) return null;

  return { cookies, origins: [] };
}
