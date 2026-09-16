/**
 * LLM 호출 클라이언트.
 *
 * Keycloak 토큰 발급→캐시→Bearer 로 OpenAI-호환 chat 을 부르는 경로가 핵심이다.
 * 여기가 틀리면 매 호출마다 Keycloak 을 두드리거나(캐시 실패), 인증이 안 붙어 401 이 난다.
 * 실제 네트워크 대신 globalThis.fetch 를 가로채 검증한다.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chatWithConfig, clearTokenCache, testConnection, LlmError } from "../lib/llmClient.ts";
import type { LlmConfig } from "../lib/llmConfig.ts";

const TOKEN_URL = "https://kc.ds.lab/realms/pais/protocol/openid-connect/token";
const BASE_URL = "https://pais.ds.lab/api/v1/compatibility/openai";

function cfg(over: Partial<LlmConfig> = {}): LlmConfig {
  return {
    name: "t", modelId: "google/gemma-4-31b-it", baseUrl: BASE_URL, authKind: "keycloak",
    tokenUrl: TOKEN_URL, clientId: "pais-client", authUsername: "pais-admin", secret: "pw",
    chatPath: "/v1/chat/completions", maxTokens: 512, temperature: 0.1, systemPrompt: "",
    updatedAt: "", source: "db", ...over,
  };
}

interface Call { url: string; init: RequestInit }
let calls: Call[] = [];
const realFetch = globalThis.fetch;

/** url 별 응답을 정하는 mock. token 엔드포인트와 chat 엔드포인트를 구분한다. */
function installFetch(handler: (url: string, init: RequestInit) => Response): void {
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(handler(url, init ?? {}));
  }) as typeof fetch;
}

function tokenResponse(token = "tok-123", expiresIn = 300): Response {
  return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}
function chatResponse(content = "안녕하세요"): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  calls = [];
  clearTokenCache();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("keycloak: 토큰을 발급받아 Bearer 로 chat 을 부른다", async () => {
  installFetch((url) => (url === TOKEN_URL ? tokenResponse() : chatResponse("결과")));
  const out = await chatWithConfig(cfg(), "sys", "user");
  assert.equal(out, "결과");

  const tokenCall = calls.find((c) => c.url === TOKEN_URL);
  assert.ok(tokenCall);
  assert.match(String(tokenCall.init.body), /grant_type=password/);
  assert.match(String(tokenCall.init.body), /client_id=pais-client/);

  const chatCall = calls.find((c) => c.url.endsWith("/v1/chat/completions"));
  assert.ok(chatCall);
  const headers = chatCall.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer tok-123");
  const body = JSON.parse(String(chatCall.init.body)) as { model: string; max_tokens: number };
  assert.equal(body.model, "google/gemma-4-31b-it");
  assert.equal(body.max_tokens, 512);
});

test("토큰은 캐시된다 — 두 번 불러도 발급은 한 번", async () => {
  installFetch((url) => (url === TOKEN_URL ? tokenResponse() : chatResponse()));
  await chatWithConfig(cfg(), "s", "u");
  await chatWithConfig(cfg(), "s", "u");
  assert.equal(calls.filter((c) => c.url === TOKEN_URL).length, 1);
  assert.equal(calls.filter((c) => c.url.endsWith("/v1/chat/completions")).length, 2);
});

test("bearer 방식은 토큰을 발급하지 않고 secret 을 그대로 Bearer 로 쓴다", async () => {
  installFetch(() => chatResponse());
  await chatWithConfig(cfg({ authKind: "bearer", secret: "api-key-xyz" }), "s", "u");
  assert.equal(calls.filter((c) => c.url === TOKEN_URL).length, 0);
  const chatCall = calls[0];
  assert.ok(chatCall);
  const headers = chatCall.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer api-key-xyz");
});

test("none 방식은 Authorization 헤더가 없다", async () => {
  installFetch(() => chatResponse());
  await chatWithConfig(cfg({ authKind: "none" }), "s", "u");
  const first = calls[0];
  assert.ok(first);
  const headers = first.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, undefined);
});

test("시스템 지침이 있으면 호출자의 system 앞에 덧붙는다", async () => {
  installFetch((url) => (url === TOKEN_URL ? tokenResponse() : chatResponse()));
  await chatWithConfig(cfg({ systemPrompt: "전역지침" }), "호출자시스템", "u");
  const chatCall = calls.find((c) => c.url.endsWith("/v1/chat/completions"));
  const body = JSON.parse(String(chatCall?.init.body)) as { messages: Array<{ role: string; content: string }> };
  assert.equal(body.messages[0]?.content, "전역지침\n\n호출자시스템");
});

test("옵션의 maxTokens·temperature 가 설정값을 덮는다", async () => {
  installFetch((url) => (url === TOKEN_URL ? tokenResponse() : chatResponse()));
  await chatWithConfig(cfg(), "s", "u", { maxTokens: 3000, temperature: 0 });
  const chatCall = calls.find((c) => c.url.endsWith("/v1/chat/completions"));
  const body = JSON.parse(String(chatCall?.init.body)) as { max_tokens: number; temperature: number };
  assert.equal(body.max_tokens, 3000);
  assert.equal(body.temperature, 0);
});

test("chat 이 비-200 이면 LlmError 를 던진다", async () => {
  installFetch((url) =>
    url === TOKEN_URL ? tokenResponse() : new Response("upstream down", { status: 502 }));
  await assert.rejects(() => chatWithConfig(cfg(), "s", "u"), LlmError);
});

test("빈 응답이면 던진다 (빈 문서를 성공으로 오해하지 않는다)", async () => {
  installFetch((url) => (url === TOKEN_URL ? tokenResponse() : chatResponse("")));
  await assert.rejects(() => chatWithConfig(cfg(), "s", "u"), /빈 응답/);
});

test("토큰 발급이 거부되면 LlmError", async () => {
  installFetch((url) =>
    url === TOKEN_URL ? new Response("invalid_grant", { status: 401 }) : chatResponse());
  await assert.rejects(() => chatWithConfig(cfg(), "s", "u"), LlmError);
});

test("testConnection 은 성공 시 {ok:true, detail} 을 준다", async () => {
  installFetch((url) => (url === TOKEN_URL ? tokenResponse() : chatResponse("OK")));
  const r = await testConnection(cfg());
  assert.equal(r.ok, true);
  assert.match(r.detail, /OK/);
});

test("testConnection 은 실패해도 던지지 않고 {ok:false, detail} 을 준다", async () => {
  installFetch((url) =>
    url === TOKEN_URL ? new Response("nope", { status: 401 }) : chatResponse());
  const r = await testConnection(cfg());
  assert.equal(r.ok, false);
  assert.ok(r.detail.length > 0);
});
