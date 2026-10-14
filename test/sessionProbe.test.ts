/**
 * 세션 확인 규칙.
 *
 * 핵심은 **"죽음" 과 "모름" 을 섞지 않는 것**이다. VPN 이 잠깐 끊겼을 때 "세션 없음" 으로
 * 보이면 사람이 엉뚱하게 재로그인을 하러 간다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { probeSession } from "../lib/sessionProbe.ts";
import type { ApiClient } from "../collector/httpClient.ts";

/** 상태 코드만 돌려주는 가짜 클라이언트. */
function clientWith(status: number): ApiClient {
  return {
    get: async () => ({
      status: () => status,
      ok: () => status >= 200 && status < 300,
      json: async () => ({}),
      text: async () => "",
    }),
    post: async () => {
      throw new Error("세션 확인은 GET 만 쓴다");
    },
  };
}

/** 망이 끊긴 클라이언트. */
const throwingClient: ApiClient = {
  get: async () => {
    throw new Error("fetch failed");
  },
  post: async () => {
    throw new Error("쓰지 않는다");
  },
};

test("200 이면 살아 있다", async () => {
  assert.equal(await probeSession(clientWith(200)), "alive");
});

test("401·403 이면 죽었다", async () => {
  assert.equal(await probeSession(clientWith(401)), "dead");
  assert.equal(await probeSession(clientWith(403)), "dead");
});

// 포털 장애(5xx)를 세션 만료로 보면 사람이 엉뚱하게 재로그인을 되풀이한다.
test("그 밖의 상태는 판정하지 않는다", async () => {
  assert.equal(await probeSession(clientWith(500)), "unknown");
  assert.equal(await probeSession(clientWith(502)), "unknown");
  assert.equal(await probeSession(clientWith(302)), "unknown");
});

// VPN 이 끊긴 것은 세션이 죽은 것과 다르다.
test("망 오류는 모름이고, 던지지 않는다", async () => {
  assert.equal(await probeSession(throwingClient), "unknown");
});
