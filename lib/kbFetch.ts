/**
 * Broadcom 기술문서 HTTP 접근.
 *
 * 인증이 필요 없다 — 브라우저도 Broadcom 세션도 쓰지 않는다. 케이스 수집이 세션
 * 만료로 멈춰 있어도 이쪽은 정상 동작한다(CVE 수집과 같은 성질).
 *
 * 파싱은 kb.ts 에 있다. 여기는 받아오기만 한다.
 */
import { parseSitemap, parseSitemapIndex, type KbEntry } from "./kb.ts";

const BASE = "https://knowledge.broadcom.com";
const SITEMAP_INDEX = `${BASE}/sitemap.xml`;
const TIMEOUT_MS = 45_000;
const UA = "broadcom-sr-hub/0.1";

export class KbError extends Error {
  // Node 의 타입 스트리핑은 생성자 파라미터 프로퍼티를 지원하지 않는다.
  // 필드를 명시적으로 선언한다.
  readonly url: string;
  readonly status: number;

  constructor(url: string, status: number, detail: string) {
    super(`기술문서 요청 실패 (${url}): ${detail}`);
    this.name = "KbError";
    this.url = url;
    this.status = status;
  }
}

async function get(url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "text/html,application/xml", "User-Agent": UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    // 네트워크·타임아웃도 상태 0 으로 감싼다. 호출부가 한 종류만 붙잡으면 되게 한다.
    throw new KbError(url, 0, error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) throw new KbError(url, response.status, `HTTP ${response.status}`);
  return response.text();
}

/** 자식 사이트맵 주소 목록. 뒤쪽일수록 최신 문서다. */
export function fetchSitemapIndex(): Promise<string[]> {
  return get(SITEMAP_INDEX).then(parseSitemapIndex);
}

/** 자식 사이트맵 한 장의 문서 목록. */
export function fetchSitemapPage(url: string): Promise<KbEntry[]> {
  return get(url).then(parseSitemap);
}

/**
 * 최신 사이트맵부터 count 장을 읽어 문서 목록을 모은다.
 *
 * 전체 18만 건을 받는 것은 무리라, 기본은 마지막 한 장(가장 최근 문서들)이다.
 * 더 거슬러 올라가려면 count 를 올린다.
 */
export async function fetchLatestEntries(count = 1): Promise<KbEntry[]> {
  const pages = await fetchSitemapIndex();
  const picked = pages.slice(Math.max(0, pages.length - count));
  const out: KbEntry[] = [];
  for (const page of picked) out.push(...(await fetchSitemapPage(page)));
  return out;
}

/** 문서 본문 HTML. */
export function fetchArticleHtml(url: string): Promise<string> {
  return get(url);
}
