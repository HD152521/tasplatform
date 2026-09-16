/**
 * 쿠키 저장소.
 *
 * 브라우저 없이 API 를 부르는 빠른 경로의 심장이다. 여기가 틀리면
 * 회전된 세션 쿠키를 놓쳐 다음 실행이 401 로 죽는다 — 그것도 조용히.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CookieJar, domainMatches, parseSetCookie, pathMatches } from "../collector/cookieJar.ts";

const API = new URL("https://api-broadcomcms-software.wolkenservicedesk.com/account_service/x");

test("앞에 점이 붙은 도메인은 서브도메인에도 적용된다", () => {
  assert.equal(domainMatches(".wolkenservicedesk.com", "api-x.wolkenservicedesk.com"), true);
  assert.equal(domainMatches("wolkenservicedesk.com", "wolkenservicedesk.com"), true);
  assert.equal(domainMatches(".broadcom.com", "api-x.wolkenservicedesk.com"), false);
});

test("도메인 끝부분이 우연히 겹치는 것은 매칭이 아니다", () => {
  // evil-wolkenservicedesk.com 에 쿠키가 새면 안 된다
  assert.equal(domainMatches(".wolkenservicedesk.com", "evilwolkenservicedesk.com"), false);
});

test("경로는 접두사 단위로만 매칭된다", () => {
  assert.equal(pathMatches("/", "/anything"), true);
  assert.equal(pathMatches("/api", "/api"), true);
  assert.equal(pathMatches("/api", "/api/v1"), true);
  assert.equal(pathMatches("/api", "/apiv2"), false);
});

test("Set-Cookie 의 이름·값과 속성을 읽는다", () => {
  const c = parseSetCookie("sid=abc123; Path=/; Secure; HttpOnly", API);
  assert.equal(c?.name, "sid");
  assert.equal(c?.value, "abc123");
  assert.equal(c?.path, "/");
});

test("Domain 이 없으면 요청 호스트를 쓴다", () => {
  const c = parseSetCookie("sid=abc", API);
  assert.equal(c?.domain, API.hostname);
});

test("Max-Age 를 만료 시각으로 바꾼다", () => {
  const c = parseSetCookie("sid=abc; Max-Age=3600", API);
  assert.ok(c?.expires !== undefined);
  const secondsAhead = (c.expires ?? 0) - Math.round(Date.now() / 1000);
  assert.ok(secondsAhead > 3500 && secondsAhead <= 3600, `예상 밖: ${secondsAhead}`);
});

test("망가진 Set-Cookie 줄은 버린다", () => {
  assert.equal(parseSetCookie("", API), null);
  assert.equal(parseSetCookie("=novalue", API), null);
});

test("해당 도메인 쿠키만 헤더에 넣는다", () => {
  const jar = new CookieJar([
    { name: "a", value: "1", domain: ".wolkenservicedesk.com", path: "/" },
    { name: "b", value: "2", domain: "access.broadcom.com", path: "/" },
  ]);
  assert.equal(jar.header(API), "a=1");
});

test("만료된 쿠키는 보내지 않는다", () => {
  const past = Math.round(Date.now() / 1000) - 60;
  const jar = new CookieJar([
    { name: "dead", value: "x", domain: ".wolkenservicedesk.com", path: "/", expires: past },
    { name: "live", value: "y", domain: ".wolkenservicedesk.com", path: "/" },
  ]);
  assert.equal(jar.header(API), "live=y");
});

test("Set-Cookie 로 같은 쿠키가 오면 값을 갈아 끼운다", () => {
  const jar = new CookieJar([
    { name: "sid", value: "old", domain: ".wolkenservicedesk.com", path: "/" },
  ]);
  jar.apply(["sid=new; Path=/"], API);
  assert.equal(jar.header(API), "sid=new");
  assert.equal(jar.snapshot().filter((c) => c.name === "sid").length, 1, "중복 생성 금지");
});

test("새 쿠키는 추가된다", () => {
  const jar = new CookieJar([]);
  jar.apply(["fresh=1; Path=/"], API);
  assert.equal(jar.header(API), "fresh=1");
});

test("변경이 없으면 파일을 쓰지 않는다", () => {
  const file = join(mkdtempSync(join(tmpdir(), "jar-")), "session.json");
  writeFileSync(file, JSON.stringify({ cookies: [], origins: [{ origin: "x" }] }), "utf8");
  const jar = CookieJar.fromFile(file);
  assert.equal(jar.hasChanges(), false);
  assert.equal(jar.persist(file), false);
});

test("저장할 때 origins 를 보존한다", () => {
  // origins 에 기기 지문이 들어 있다. 이게 날아가면 다음 로그인이 OTP 를 묻는다.
  const file = join(mkdtempSync(join(tmpdir(), "jar-")), "session.json");
  const origins = [{ origin: "https://access.broadcom.com", localStorage: [{ name: "_ia01", value: "fp" }] }];
  writeFileSync(file, JSON.stringify({ cookies: [], origins }), "utf8");

  const jar = CookieJar.fromFile(file);
  jar.apply(["sid=rotated; Path=/"], API);
  assert.equal(jar.persist(file), true);

  const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  assert.deepEqual(saved.origins, origins);
  assert.equal((saved.cookies as Array<{ name: string }>)[0]?.name, "sid");
});
