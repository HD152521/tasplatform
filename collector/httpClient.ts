/**
 * API 클라이언트.
 *
 * api.ts 가 실제로 쓰는 건 get/post 두 개뿐이라, 그 최소 모양만 인터페이스로 두고
 * 구현을 두 가지 둔다.
 *
 *   fetch 구현   — 세션이 살아 있을 때(거의 모든 실행). 브라우저를 띄우지 않는다.
 *   브라우저 구현 — 세션이 죽어 SSO 갱신이나 재로그인이 필요할 때의 폴백.
 *
 * 실측: 브라우저 경로는 실행 33초 중 30초를 브라우저 수명주기에 쓴다(대부분
 * storageState 의 origin 탐색). 실제 데이터 왕복은 1초가 안 된다.
 */
import type { APIRequestContext } from "playwright";
import { CookieJar } from "./cookieJar.ts";

export interface ApiResponseLike {
  status(): number;
  ok(): boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface RequestOptions {
  headers?: Record<string, string>;
}

export interface MultipartOptions extends RequestOptions {
  multipart: Record<string, string>;
}

export interface ApiClient {
  get(url: string, options?: RequestOptions): Promise<ApiResponseLike>;
  post(url: string, options: MultipartOptions): Promise<ApiResponseLike>;
}

/** Playwright 컨텍스트를 클라이언트로 감싼다. 폴백 경로용. */
export function browserClient(request: APIRequestContext): ApiClient {
  return {
    get: (url, options) => request.get(url, { headers: options?.headers }),
    post: (url, options) =>
      request.post(url, { multipart: options.multipart, headers: options.headers }),
  };
}

function toResponse(response: Response, body: string): ApiResponseLike {
  return {
    status: () => response.status,
    ok: () => response.ok,
    json: async () => JSON.parse(body) as unknown,
    text: async () => body,
  };
}

export interface HttpClient extends ApiClient {
  /** 회전된 쿠키를 세션 파일에 되돌린다. 변경이 없으면 쓰지 않는다. */
  persist(): boolean;
}

/**
 * 세션 파일의 쿠키로 동작하는 fetch 클라이언트.
 * 응답의 Set-Cookie 를 그때그때 반영한다 — 서버가 세션 쿠키를 회전시키기 때문이다.
 */
export function fetchClient(sessionFile: string): HttpClient {
  const jar = CookieJar.fromFile(sessionFile);

  async function send(url: string, init: RequestInit, headers?: Record<string, string>) {
    const target = new URL(url);
    const cookie = jar.header(target);
    const response = await fetch(url, {
      ...init,
      headers: { ...headers, ...(cookie === "" ? {} : { Cookie: cookie }) },
    });
    jar.apply(response.headers.getSetCookie(), target);
    return toResponse(response, await response.text());
  }

  return {
    get: (url, options) => send(url, { method: "GET" }, options?.headers),
    post: (url, options) => {
      const form = new FormData();
      for (const [key, value] of Object.entries(options.multipart)) form.append(key, value);
      // Content-Type 은 지정하지 않는다. FormData 가 boundary 를 포함해 직접 채운다.
      return send(url, { method: "POST", body: form }, options.headers);
    },
    persist: () => jar.persist(sessionFile),
  };
}
