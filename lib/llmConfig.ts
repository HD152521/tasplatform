/**
 * LLM 연결 설정 저장·조회.
 *
 * 전역 단일 활성 연결(llm_id='default')을 다룬다. 요약·리포트·답변요약이 이 설정을
 * 읽어 OpenAI 대신 지정한 OpenAI-호환 엔드포인트(Gemma 등)를 쓴다.
 *
 * 비밀번호(또는 API 키)는 secretBox 로 암호화해 저장한다. 화면용(getLlmConfigMeta)은
 * 평문·암호문을 절대 반환하지 않고 존재 여부(hasSecret)만 돌려준다. 내부 리졸버용
 * (getLlmConfig)만 복호화한 값을 돌려주며, 이 결과를 화면·API 응답에 실어 보내면 안 된다.
 *
 * DB 에 설정이 없으면 환경변수(LLM_*)로 폴백한다 — TAS 처럼 파일시스템이 ephemeral 인
 * 환경에서 .env 만으로 설정을 유지하려는 경우를 위해서다.
 *
 * server-only 를 붙이지 않는다. 수집기(Node)에서도 부른다.
 */
import { isoNow } from "./dates.ts";
import type { Db } from "./db.ts";
import { decryptSecret, encryptSecret } from "./secretBox.ts";

export const DEFAULT_LLM_ID = "default";
export const DEFAULT_CHAT_PATH = "/v1/chat/completions";
export const DEFAULT_MAX_TOKENS = 512;
export const DEFAULT_TEMPERATURE = 0.1;

export type LlmAuthKind = "keycloak" | "bearer" | "none";
const AUTH_KINDS: readonly LlmAuthKind[] = ["keycloak", "bearer", "none"];

/** 내부 리졸버 전용. secret(복호화 평문)이 담긴다 — 화면/HTTP 응답에 노출 금지. */
export interface LlmConfig {
  name: string;
  modelId: string;
  baseUrl: string;
  authKind: LlmAuthKind;
  tokenUrl: string;
  clientId: string;
  authUsername: string;
  /** 복호화된 비밀번호 또는 API 키. 내부 전용. */
  secret: string;
  chatPath: string;
  maxTokens: number;
  temperature: number;
  systemPrompt: string;
  updatedAt: string;
  /** 이 설정이 어디서 왔는지. 'db' = 설정 화면, 'env' = 환경변수 폴백. */
  source: "db" | "env";
}

/** 화면용. 민감값(secret) 없이 존재 여부만. */
export interface LlmConfigMeta {
  name: string;
  modelId: string;
  baseUrl: string;
  authKind: LlmAuthKind;
  tokenUrl: string;
  clientId: string;
  authUsername: string;
  hasSecret: boolean;
  chatPath: string;
  maxTokens: number;
  temperature: number;
  systemPrompt: string;
  updatedAt: string;
  source: "db" | "env";
}

interface LlmRowRaw {
  llm_id: string;
  name: string;
  model_id: string;
  base_url: string;
  auth_kind: string;
  token_url: string;
  client_id: string;
  auth_username: string;
  secret_enc: string;
  chat_path: string;
  max_tokens: number;
  temperature: number;
  system_prompt: string;
  updated_at: string;
}

function coerceAuthKind(value: string): LlmAuthKind {
  return (AUTH_KINDS as readonly string[]).includes(value) ? (value as LlmAuthKind) : "keycloak";
}

/** https 만 허용한다. 비밀번호/토큰이 실려 나갈 주소를 평문 http 로 두지 않기 위해서다. */
export function assertHttpsUrl(label: string, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} 형식이 올바르지 않습니다: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${label} 은 https 여야 합니다.`);
  }
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export interface UpsertLlmInput {
  name: string;
  modelId: string;
  baseUrl: string;
  authKind: LlmAuthKind;
  tokenUrl: string;
  clientId: string;
  authUsername: string;
  /** 빈 문자열이면 "이 필드는 바꾸지 않음"(기존 비밀번호 유지). */
  secret?: string;
  chatPath: string;
  maxTokens: number;
  temperature: number;
  systemPrompt: string;
}

/**
 * 등록/수정(단일 'default' 행).
 * - base_url·model 필수, keycloak 이면 token_url·client_id·username 필수.
 * - secret 이 비어 있으면 기존 암호문을 유지한다.
 * - secret 이 채워졌는데 SR_SECRET_KEY 가 없으면 encryptSecret 이 던지고 저장을 거부한다
 *   (평문 저장 폴백 금지, 행이 부분적으로도 남지 않음).
 */
export async function upsertLlmConfig(db: Db, input: UpsertLlmInput): Promise<void> {
  const name = input.name.trim();
  const modelId = input.modelId.trim();
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const authKind = coerceAuthKind(input.authKind);
  const tokenUrl = input.tokenUrl.trim();
  const clientId = input.clientId.trim();
  const authUsername = input.authUsername.trim();
  const chatPath = input.chatPath.trim() || DEFAULT_CHAT_PATH;
  const systemPrompt = input.systemPrompt;

  if (modelId === "") throw new Error("모델 ID 가 필요합니다.");
  if (baseUrl === "") throw new Error("API 기본 주소가 필요합니다.");
  assertHttpsUrl("API 기본 주소", baseUrl);

  if (authKind === "keycloak") {
    if (tokenUrl === "") throw new Error("Keycloak 인증에는 토큰 발급 URL 이 필요합니다.");
    assertHttpsUrl("토큰 발급 URL", tokenUrl);
    if (clientId === "") throw new Error("Keycloak 인증에는 Client ID 가 필요합니다.");
    if (authUsername === "") throw new Error("Keycloak 인증에는 인증 사용자 이름이 필요합니다.");
  }

  const maxTokens = Number.isFinite(input.maxTokens) && input.maxTokens > 0
    ? Math.floor(input.maxTokens) : DEFAULT_MAX_TOKENS;
  const temperature = Number.isFinite(input.temperature) && input.temperature >= 0
    ? input.temperature : DEFAULT_TEMPERATURE;

  const secretInput = (input.secret ?? "").trim();
  const secretEnc = secretInput === "" ? "" : encryptSecret(secretInput);

  await db.run(
    `INSERT INTO llm_connections
       (llm_id, name, model_id, base_url, auth_kind, token_url, client_id, auth_username,
        secret_enc, chat_path, max_tokens, temperature, system_prompt, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(llm_id) DO UPDATE SET
       name          = excluded.name,
       model_id      = excluded.model_id,
       base_url      = excluded.base_url,
       auth_kind     = excluded.auth_kind,
       token_url     = excluded.token_url,
       client_id     = excluded.client_id,
       auth_username = excluded.auth_username,
       secret_enc    = CASE WHEN excluded.secret_enc = '' THEN llm_connections.secret_enc ELSE excluded.secret_enc END,
       chat_path     = excluded.chat_path,
       max_tokens    = excluded.max_tokens,
       temperature   = excluded.temperature,
       system_prompt = excluded.system_prompt,
       updated_at    = excluded.updated_at`,
    [
      DEFAULT_LLM_ID, name, modelId, baseUrl, authKind, tokenUrl, clientId, authUsername,
      secretEnc, chatPath, maxTokens, temperature, systemPrompt, isoNow(),
    ],
  );
}

function readRow(db: Db): Promise<LlmRowRaw | undefined> {
  return db.get<LlmRowRaw>("SELECT * FROM llm_connections WHERE llm_id = ?", [DEFAULT_LLM_ID]);
}

/** 환경변수 폴백. LLM_BASE_URL 이 있으면 .env 기반 설정을 만든다. */
function fromEnv(): LlmConfig | null {
  const baseUrl = normalizeBaseUrl(process.env.LLM_BASE_URL ?? "");
  if (baseUrl === "") return null;
  const num = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    name: (process.env.LLM_NAME ?? "환경변수 LLM").trim(),
    modelId: (process.env.LLM_MODEL ?? "").trim(),
    baseUrl,
    authKind: coerceAuthKind((process.env.LLM_AUTH_KIND ?? "keycloak").trim()),
    tokenUrl: (process.env.LLM_TOKEN_URL ?? "").trim(),
    clientId: (process.env.LLM_CLIENT_ID ?? "").trim(),
    authUsername: (process.env.LLM_USERNAME ?? "").trim(),
    secret: process.env.LLM_PASSWORD ?? "",
    chatPath: (process.env.LLM_CHAT_PATH ?? DEFAULT_CHAT_PATH).trim(),
    maxTokens: num(process.env.LLM_MAX_TOKENS, DEFAULT_MAX_TOKENS),
    temperature: num(process.env.LLM_TEMPERATURE, DEFAULT_TEMPERATURE),
    systemPrompt: process.env.LLM_SYSTEM_PROMPT ?? "",
    updatedAt: "",
    source: "env",
  };
}

function rowToConfig(row: LlmRowRaw): LlmConfig {
  return {
    name: row.name,
    modelId: row.model_id,
    baseUrl: row.base_url,
    authKind: coerceAuthKind(row.auth_kind),
    tokenUrl: row.token_url,
    clientId: row.client_id,
    authUsername: row.auth_username,
    secret: row.secret_enc === "" ? "" : decryptSecret(row.secret_enc),
    chatPath: row.chat_path || DEFAULT_CHAT_PATH,
    maxTokens: row.max_tokens,
    temperature: row.temperature,
    systemPrompt: row.system_prompt,
    updatedAt: row.updated_at,
    source: "db",
  };
}

/**
 * 내부 리졸버용. 복호화된 secret 을 포함한 설정을 돌려준다(없으면 null).
 * DB 우선, 없으면 환경변수 폴백. 화면/HTTP 응답에 그대로 실어 보내지 말 것.
 */
export async function getLlmConfig(db: Db): Promise<LlmConfig | null> {
  const row = await readRow(db);
  if (row) return rowToConfig(row);
  return fromEnv();
}

/** 화면용. 민감값 없이. */
export async function getLlmConfigMeta(db: Db): Promise<LlmConfigMeta | null> {
  const row = await readRow(db);
  if (row) {
    return {
      name: row.name,
      modelId: row.model_id,
      baseUrl: row.base_url,
      authKind: coerceAuthKind(row.auth_kind),
      tokenUrl: row.token_url,
      clientId: row.client_id,
      authUsername: row.auth_username,
      hasSecret: row.secret_enc !== "",
      chatPath: row.chat_path || DEFAULT_CHAT_PATH,
      maxTokens: row.max_tokens,
      temperature: row.temperature,
      systemPrompt: row.system_prompt,
      updatedAt: row.updated_at,
      source: "db",
    };
  }
  const env = fromEnv();
  if (!env) return null;
  return {
    name: env.name,
    modelId: env.modelId,
    baseUrl: env.baseUrl,
    authKind: env.authKind,
    tokenUrl: env.tokenUrl,
    clientId: env.clientId,
    authUsername: env.authUsername,
    hasSecret: env.secret.trim() !== "",
    chatPath: env.chatPath,
    maxTokens: env.maxTokens,
    temperature: env.temperature,
    systemPrompt: env.systemPrompt,
    updatedAt: env.updatedAt,
    source: "env",
  };
}

/** 삭제(단일 행). 없어도 조용히 반환한다. */
export async function deleteLlmConfig(db: Db): Promise<void> {
  await db.run("DELETE FROM llm_connections WHERE llm_id = ?", [DEFAULT_LLM_ID]);
}
