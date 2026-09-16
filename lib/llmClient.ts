/**
 * LLM 호출 클라이언트 (OpenAI-호환 엔드포인트 + Keycloak 토큰).
 *
 * 인증 방식(config.authKind):
 *   keycloak = 호출마다 액세스 토큰이 필요하다. token_url 에 비밀번호 그랜트로 발급받고
 *              Bearer 로 쓴다. 토큰은 만료 전까지 프로세스 메모리에 캐시한다(매 호출마다
 *              Keycloak 을 두드리지 않는다).
 *   bearer   = secret 을 그대로 Bearer(API 키)로 쓴다.
 *   none     = 인증 헤더 없음.
 *
 * server-only 를 붙이지 않는다. 수집기(Node)에서도 부른다.
 */
import type { LlmConfig } from "./llmConfig.ts";

export class LlmError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`LLM 호출 실패 (HTTP ${status}): ${detail}`.trim());
    this.name = "LlmError";
    this.status = status;
  }
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const TOKEN_TIMEOUT_MS = 15_000;
/** 만료 직전에 새로 받도록 남기는 여유(초). 시계 오차·지연을 흡수한다. */
const TOKEN_MARGIN_S = 30;

interface CachedToken {
  token: string;
  /** epoch ms. 이 시각을 지나면 폐기하고 다시 받는다. */
  expiresAt: number;
}

// (token_url|client_id|username) -> 캐시된 토큰. 여러 설정이 있어도 섞이지 않게 키에 담는다.
const tokenCache = new Map<string, CachedToken>();
// 동시에 여러 호출이 만료를 발견해도 Keycloak 을 한 번만 두드리도록 진행 중 요청을 공유한다.
const inflight = new Map<string, Promise<string>>();

function tokenCacheKey(config: LlmConfig): string {
  return `${config.tokenUrl}|${config.clientId}|${config.authUsername}`;
}

async function fetchKeycloakToken(config: LlmConfig): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: config.clientId,
    username: config.authUsername,
    password: config.secret,
  });

  let response: Response;
  try {
    response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (error) {
    throw new LlmError(0, `토큰 발급 요청 실패: ${error instanceof Error ? error.message : String(error)}`);
  }

  const raw = await response.text();
  if (!response.ok) {
    throw new LlmError(response.status, `토큰 발급 거부: ${raw.slice(0, 200)}`);
  }

  let parsed: { access_token?: string; expires_in?: number };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new LlmError(response.status, "토큰 응답을 해석하지 못했습니다.");
  }
  const token = parsed.access_token ?? "";
  if (token === "") throw new LlmError(response.status, "토큰 응답에 access_token 이 없습니다.");

  const ttlS = typeof parsed.expires_in === "number" && parsed.expires_in > 0 ? parsed.expires_in : 60;
  const expiresAt = Date.now() + Math.max(ttlS - TOKEN_MARGIN_S, 5) * 1000;
  tokenCache.set(tokenCacheKey(config), { token, expiresAt });
  return token;
}

/** Keycloak 액세스 토큰(캐시 우선). 진행 중 요청은 공유한다. */
async function getKeycloakToken(config: LlmConfig): Promise<string> {
  const key = tokenCacheKey(config);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = fetchKeycloakToken(config).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

/** 이 설정 기준의 Authorization 헤더 값(없으면 undefined). */
async function authHeader(config: LlmConfig): Promise<string | undefined> {
  if (config.authKind === "none") return undefined;
  if (config.authKind === "bearer") {
    if (config.secret.trim() === "") throw new LlmError(0, "Bearer 인증인데 토큰(secret)이 비어 있습니다.");
    return `Bearer ${config.secret.trim()}`;
  }
  // keycloak
  return `Bearer ${await getKeycloakToken(config)}`;
}

function chatUrl(config: LlmConfig): string {
  const path = config.chatPath.startsWith("/") ? config.chatPath : `/${config.chatPath}`;
  return `${config.baseUrl.replace(/\/+$/, "")}${path}`;
}

/**
 * system + user 한 번 주고받기. 실패는 던진다(빈 문서를 성공으로 오해하지 않도록).
 *
 * - model/temperature/max_tokens 는 설정값이 기본, 호출 옵션이 있으면 그쪽이 우선한다
 *   (리포트처럼 긴 출력이 필요한 호출은 자기 maxTokens 를 넘겨 512 기본값을 넘어선다).
 * - 설정에 시스템 지침(systemPrompt)이 있으면 호출자의 system 앞에 덧붙인다.
 */
export async function chatWithConfig(
  config: LlmConfig,
  system: string,
  user: string,
  options: ChatOptions = {},
): Promise<string> {
  const authorization = await authHeader(config);
  const mergedSystem = config.systemPrompt.trim() === ""
    ? system
    : `${config.systemPrompt.trim()}\n\n${system}`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authorization) headers.Authorization = authorization;

  let response: Response;
  try {
    response = await fetch(chatUrl(config), {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.modelId,
        temperature: options.temperature ?? config.temperature,
        max_tokens: options.maxTokens ?? config.maxTokens,
        messages: [
          { role: "system", content: mergedSystem },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new LlmError(0, `요청 실패: ${error instanceof Error ? error.message : String(error)}`);
  }

  const raw = await response.text();
  if (!response.ok) throw new LlmError(response.status, raw.slice(0, 200));

  let parsed: { choices?: Array<{ message?: { content?: string } }> };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new LlmError(response.status, "응답을 해석하지 못했습니다.");
  }
  const out = parsed.choices?.[0]?.message?.content ?? "";
  if (out.trim() === "") throw new LlmError(response.status, "빈 응답");
  return out.trim();
}

export interface TestResult {
  ok: boolean;
  /** 성공: 모델이 돌려준 짧은 응답 일부. 실패: 실패 사유. */
  detail: string;
}

/**
 * 연결 테스트. 토큰 발급(해당 시) + 아주 짧은 chat 왕복으로 전체 경로를 검증한다.
 * 던지지 않고 {ok, detail} 로 돌려준다 — 화면이 성공/실패를 그대로 보여주기 위해서다.
 */
export async function testConnection(config: LlmConfig): Promise<TestResult> {
  try {
    const reply = await chatWithConfig(
      config,
      "You are a connection test. Reply with a single short word.",
      "Reply with the word: OK",
      { maxTokens: 8, temperature: 0, timeoutMs: 20_000 },
    );
    return { ok: true, detail: reply.slice(0, 120) };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** 테스트에서 캐시된 토큰을 강제로 비우고 싶을 때(설정 변경 직후 등). */
export function clearTokenCache(): void {
  tokenCache.clear();
  inflight.clear();
}
