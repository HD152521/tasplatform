/**
 * 세션 쿠키 저장소.
 *
 * 브라우저 없이 API 를 호출하려면 쿠키를 직접 관리해야 한다.
 * 서버가 접속 때마다 세션 쿠키를 회전시키므로, 응답의 Set-Cookie 를 반영하고
 * 파일에 되돌려 놓지 않으면 다음 실행이 401 로 실패한다.
 *
 * `origins`(localStorage)는 절대 건드리지 않는다. 거기에 기기 지문이 들어 있고
 * 로그인할 때만 갱신되면 된다. 수집 경로에서 읽고 쓰면 origin 당 네트워크 탐색이
 * 일어나 실행마다 십수 초가 든다 — 브라우저를 걷어내는 이유가 바로 그것이다.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface JarCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  [key: string]: unknown;
}

/** 쿠키 도메인이 요청 호스트에 적용되는가. 앞의 점은 서브도메인 허용을 뜻한다. */
export function domainMatches(cookieDomain: string, host: string): boolean {
  const bare = cookieDomain.startsWith(".") ? cookieDomain.slice(1) : cookieDomain;
  return host === bare || host.endsWith(`.${bare}`);
}

export function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (cookiePath === "" || cookiePath === "/") return true;
  if (requestPath === cookiePath) return true;
  return requestPath.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`);
}

function isAlive(cookie: JarCookie, now: number): boolean {
  if (cookie.expires === undefined || cookie.expires <= 0) return true;
  return cookie.expires * 1000 > now;
}

/**
 * Set-Cookie 한 줄을 파싱한다.
 * 서버가 주지 않은 Domain/Path 는 요청 URL 에서 채운다(RFC 6265 기본값).
 */
export function parseSetCookie(line: string, url: URL): JarCookie | null {
  const [pair, ...attrs] = line.split(";");
  const eq = pair?.indexOf("=") ?? -1;
  if (pair === undefined || eq <= 0) return null;

  const cookie: JarCookie = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    domain: url.hostname,
    path: "/",
  };

  for (const attr of attrs) {
    const idx = attr.indexOf("=");
    const key = (idx < 0 ? attr : attr.slice(0, idx)).trim().toLowerCase();
    const value = idx < 0 ? "" : attr.slice(idx + 1).trim();
    if (key === "domain" && value !== "") cookie.domain = value.startsWith(".") ? value : `.${value}`;
    else if (key === "path" && value !== "") cookie.path = value;
    else if (key === "expires" && value !== "") {
      const ms = Date.parse(value);
      if (!Number.isNaN(ms)) cookie.expires = Math.round(ms / 1000);
    } else if (key === "max-age" && value !== "") {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) cookie.expires = Math.round(Date.now() / 1000) + seconds;
    }
  }
  return cookie;
}

export class CookieJar {
  private cookies: JarCookie[];
  private dirty = false;

  constructor(cookies: JarCookie[]) {
    this.cookies = [...cookies];
  }

  /** 세션 파일에서 쿠키만 읽어 온다. */
  static fromFile(sessionFile: string): CookieJar {
    const parsed = JSON.parse(readFileSync(resolve(sessionFile), "utf8")) as {
      cookies?: JarCookie[];
    };
    return new CookieJar(parsed.cookies ?? []);
  }

  /** 요청에 붙일 Cookie 헤더. 해당 없으면 빈 문자열. */
  header(url: URL, now = Date.now()): string {
    return this.cookies
      .filter(
        (c) =>
          isAlive(c, now) &&
          domainMatches(c.domain, url.hostname) &&
          pathMatches(c.path ?? "/", url.pathname),
      )
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  /** 응답의 Set-Cookie 를 반영한다. 같은 이름/도메인/경로면 덮어쓴다. */
  apply(setCookieLines: readonly string[], url: URL): void {
    for (const line of setCookieLines) {
      const incoming = parseSetCookie(line, url);
      if (incoming === null) continue;

      const at = this.cookies.findIndex(
        (c) =>
          c.name === incoming.name &&
          domainMatches(c.domain, url.hostname) &&
          (c.path ?? "/") === incoming.path,
      );
      if (at >= 0) this.cookies[at] = { ...this.cookies[at], ...incoming };
      else this.cookies.push(incoming);
      this.dirty = true;
    }
  }

  snapshot(): JarCookie[] {
    return [...this.cookies];
  }

  hasChanges(): boolean {
    return this.dirty;
  }

  /**
   * 세션 파일의 cookies 만 갈아 끼운다. origins 는 읽은 그대로 되돌려 놓는다.
   * 변경이 없으면 쓰지 않는다.
   */
  persist(sessionFile: string): boolean {
    if (!this.dirty) return false;
    const path = resolve(sessionFile);
    const existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...existing, cookies: this.cookies }), "utf8");
    this.dirty = false;
    return true;
  }
}
