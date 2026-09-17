/**
 * 첨부 다운로드 원본 URL 해석 — 순수 함수.
 *
 * DB 에 저장된 docFullPath(포털이 첨부 링크로 준 값)를 그대로 원본으로 삼는다.
 * 클릭하면 Broadcom 사이트로 튀는 것을 막고, 서버가 세션으로 대신 받아 스트리밍하기
 * 위해 먼저 "어디서 받을지"만 여기서 정한다(네트워크·세션과 분리해 단위 테스트한다).
 *
 *  - 절대 URL(http/https) 이면 그대로 쓰되, 허용 호스트만 통과시킨다.
 *  - 경로만 있으면 API_ORIGIN 에 붙인다(Wolken).
 *  - 빈 값이거나 다른 스킴(file:, data: 등)이면 null — SSRF·경로 이탈을 막는다.
 *
 * 허용 호스트: Wolken 포털/BOX(첨부 실물 저장소, attachment_configuration.storageName="BOX").
 * 이 둘 밖으로는 서버가 대리 요청을 보내지 않는다.
 */
const ALLOWED_HOST_SUFFIXES: readonly string[] = [
  "wolkenservicedesk.com",
  "box.com",
  "boxcloud.com",
];

/** host 가 허용 접미사 중 하나에 정확히 걸리는가(하위 도메인 포함, 부분일치 아님). */
export function isAllowedHost(host: string): boolean {
  const h = host.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some((suffix) => h === suffix || h.endsWith(`.${suffix}`));
}

/**
 * docFullPath 를 실제로 받아올 절대 URL 로 바꾼다. 받을 수 없으면 null.
 * apiOrigin 은 경로만 있는 값을 붙일 기준(예: lib/config.ts 의 API_ORIGIN).
 */
export function resolveAttachmentUrl(docPath: string, apiOrigin: string): string | null {
  const raw = docPath.trim();
  if (raw === "") return null;

  // 절대 URL: 스킴이 붙어 있는 경우.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return isAllowedHost(url.hostname) ? url.toString() : null;
  }

  // http/https 아닌 스킴(file:, data:, mailto: ...)은 거부.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;

  // 경로만 있는 값: API_ORIGIN 에 붙인다.
  try {
    const url = new URL(raw.startsWith("/") ? raw : `/${raw}`, apiOrigin);
    return isAllowedHost(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}
