/**
 * LLM 연결 설정 저장·조회.
 *
 * **연결을 여러 개 등록해 두고 그중 하나를 활성으로 쓴다.** 요약·리포트·답변요약은
 * 활성 연결만 본다(getLlmConfig) — 호출부는 어느 연결이 활성인지 몰라도 된다.
 *
 * 왜 여러 개가 필요한가: 사내 LLM 이 바뀌거나(모델 교체·엔드포인트 이전) 두 모델을
 * 번갈아 비교할 때, 설정 하나를 덮어쓰면 **돌아갈 길이 없다**. 특히 비밀번호는 다시
 * 보여주지 않으므로 덮어쓴 설정을 복원할 수 없다.
 *
 * 활성 포인터는 `app_state` 의 `llm_active_id` 한 줄이다. 표를 새로 만들지 않는 이유:
 * 전역 값 하나이고, 이 레포에 이미 "프로세스 사이에 남길 작은 값" 자리가 있다.
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
import { randomBytes } from "node:crypto";
import { getAppState, setAppState } from "./appState.ts";
import { decryptSecret, encryptSecret } from "./secretBox.ts";

/**
 * 처음 만든 연결의 id. 전에는 **유일한** 행의 id 였다 — 그 시절 DB 를 그대로 읽기
 * 위해 남긴다(활성 포인터가 없으면 이 id 를 찾는다).
 */
export const DEFAULT_LLM_ID = "default";

/** 활성 연결을 가리키는 app_state 키. */
export const ACTIVE_LLM_STATE_KEY = "llm_active_id";

/**
 * 연결 id 형식. app_state 값과 API 파라미터로 오가므로 좁게 묶는다.
 */
const LLM_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

export function assertValidLlmId(llmId: string): void {
  if (!LLM_ID_PATTERN.test(llmId)) {
    throw new Error(`잘못된 연결 id 입니다: ${JSON.stringify(llmId)}`);
  }
}

/** 새 연결의 id. 사람이 정하는 값이 아니다 — 이름은 따로 있다. */
export function newLlmId(): string {
  return `llm-${randomBytes(4).toString("hex")}`;
}
export const DEFAULT_CHAT_PATH = "/v1/chat/completions";
export const DEFAULT_MAX_TOKENS = 512;
export const DEFAULT_TEMPERATURE = 0.1;

export type LlmAuthKind = "keycloak" | "client_credentials" | "bearer" | "none";
const AUTH_KINDS: readonly LlmAuthKind[] = ["keycloak", "client_credentials", "bearer", "none"];

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

function parseUrl(label: string, url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new Error(`${label} 형식이 올바르지 않습니다: ${JSON.stringify(url)}`);
  }
}

/**
 * https 만 허용한다. **비밀번호가 실려 나가는 주소**에 쓴다(토큰 발급 URL).
 *
 * 토큰 발급은 client secret 또는 관리자 비밀번호를 본문에 담아 보낸다. 그걸 평문
 * http 로 두면 같은 망에 있는 누구든 주워 갈 수 있고, 그 비밀번호 하나로 LLM 호출이
 * 아니라 **인증 서버**를 쓸 수 있게 된다. 사내망이라도 여기는 열지 않는다.
 */
export function assertHttpsUrl(label: string, url: string): void {
  if (parseUrl(label, url).protocol !== "https:") {
    throw new Error(`${label} 은 https 여야 합니다.`);
  }
}

/**
 * http · https 둘 다 허용한다. **API 기본 주소**에 쓴다.
 *
 * ## 왜 여기만 http 를 받나
 *
 * 사내 LLM 이 http 로만 열려 있는 경우가 있다. https 를 강제하면 그 연결을 아예 등록할
 * 수 없고, 그러면 요약·번역·분류가 전부 OpenAI 로 넘어간다 — SR 내용을 사내에 두려고
 * 사내 LLM 을 붙이는 것인데 **정반대 결과**가 된다. 그래서 이쪽은 연다.
 *
 * 대신 http 로 두면 무엇이 노출되는지는 분명히 해 둔다. 요청 헤더의 **bearer 토큰**과
 * **SR 본문**이 평문으로 지나간다. 토큰은 수명이 짧고 그 LLM 에만 쓰이지만, SR 본문은
 * 고객 문장이다. 사내망 안이라는 전제가 깨지는 순간 그게 그대로 드러난다.
 *
 * 그래서 토큰 **발급** 주소(assertHttpsUrl)는 계속 https 만 받는다 — 거기 실리는 것은
 * 수명이 긴 비밀번호다.
 *
 * http/https 가 아닌 것은 막는다. `file:`·`javascript:` 같은 것이 들어오면 주소가
 * 아니라 다른 일이 벌어진다.
 */
export function assertHttpUrl(label: string, url: string): void {
  const protocol = parseUrl(label, url).protocol;
  if (protocol !== "https:" && protocol !== "http:") {
    throw new Error(`${label} 은 http 또는 https 여야 합니다.`);
  }
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export interface UpsertLlmInput {
  /**
   * 어느 연결인가. 생략하면 `default` — 연결이 하나뿐이던 시절의 호출부와
   * 시험이 그대로 돌아야 하기 때문이다. 새로 만들 때는 newLlmId() 를 쓴다.
   */
  llmId?: string;
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
 * - base_url·model 필수.
 * - keycloak 이면 token_url·client_id·username 필수(비밀번호 그랜트).
 * - client_credentials 이면 token_url·client_id·secret(=client_secret) 필수, username 불필요.
 * - secret 이 비어 있으면 기존 암호문을 유지한다.
 * - secret 이 채워졌는데 SR_SECRET_KEY 가 없으면 encryptSecret 이 던지고 저장을 거부한다
 *   (평문 저장 폴백 금지, 행이 부분적으로도 남지 않음).
 */
export async function upsertLlmConfig(db: Db, input: UpsertLlmInput): Promise<string> {
  const llmId = (input.llmId ?? DEFAULT_LLM_ID).trim() || DEFAULT_LLM_ID;
  assertValidLlmId(llmId);
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
  // 기본 주소는 http 도 받는다 — 사내 LLM 이 http 로만 열려 있는 경우가 있다
  // (assertHttpUrl 주석에 노출되는 것까지 적어 두었다).
  assertHttpUrl("API 기본 주소", baseUrl);

  if (authKind === "keycloak" || authKind === "client_credentials") {
    if (tokenUrl === "") throw new Error("Keycloak 인증에는 토큰 발급 URL 이 필요합니다.");
    assertHttpsUrl("토큰 발급 URL", tokenUrl);
    if (clientId === "") throw new Error("Keycloak 인증에는 Client ID 가 필요합니다.");
  }
  if (authKind === "keycloak" && authUsername === "") {
    throw new Error("Keycloak 인증에는 인증 사용자 이름이 필요합니다.");
  }

  const maxTokens = Number.isFinite(input.maxTokens) && input.maxTokens > 0
    ? Math.floor(input.maxTokens) : DEFAULT_MAX_TOKENS;
  const temperature = Number.isFinite(input.temperature) && input.temperature >= 0
    ? input.temperature : DEFAULT_TEMPERATURE;

  const secretInput = (input.secret ?? "").trim();
  // "빈 secret = 기존 유지" 는 편의지만, 인증 방식이 바뀌면 위험하다. 예를 들어 keycloak(관리자
  // 비밀번호 저장) → client_credentials 로 바꾸면서 secret 을 안 넣으면 옛 비밀번호가 조용히
  // client_secret 으로 재사용된다. 그래서 저장된 auth_kind 가 이번 authKind 와 같을 때만 기존
  // 시크릿을 유지하고, 방식이 바뀌면 새 시크릿을 강제한다. (none 은 시크릿을 쓰지 않으므로 제외)
  if (secretInput === "" && authKind !== "none") {
    const existing = await readRowById(db, llmId);
    const hasStoredSecret = existing !== undefined && existing.secret_enc !== "";
    const storedKind = existing !== undefined ? coerceAuthKind(existing.auth_kind) : undefined;

    if (authKind === "client_credentials" && !hasStoredSecret) {
      throw new Error("client_credentials 인증에는 client_secret 이 필요합니다.");
    }
    if (hasStoredSecret && storedKind !== authKind) {
      throw new Error("인증 방식을 바꾸면 시크릿을 다시 입력해야 합니다.");
    }
  }
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
      llmId, name, modelId, baseUrl, authKind, tokenUrl, clientId, authUsername,
      secretEnc, chatPath, maxTokens, temperature, systemPrompt, isoNow(),
    ],
  );

  // **처음 만든 연결은 자동으로 활성이 된다.** 안 그러면 저장했는데 아무것도
  // 달라지지 않고(요약이 여전히 OpenAI 로 간다) 왜 그런지 알 길이 없다.
  if ((await getActiveLlmId(db)) === null) {
    await setAppState(db, ACTIVE_LLM_STATE_KEY, llmId);
  }
  return llmId;
}

/* ------------------------------------------------------------------ *
 * 활성 연결
 * ------------------------------------------------------------------ */

/** 활성으로 지정된 id. 지정이 없으면 null(그 경우 아래 해석 순서를 따른다). */
export async function getActiveLlmId(db: Db): Promise<string | null> {
  const stored = await getAppState(db, ACTIVE_LLM_STATE_KEY);
  if (stored === null || stored.trim() === "") return null;
  return stored.trim();
}

/**
 * 활성 연결을 바꾼다. **없는 연결을 활성으로 만들 수 없다** — 그러면 요약이 조용히
 * 환경변수 폴백으로 내려가고, 화면은 바뀐 것처럼 보인다.
 */
export async function setActiveLlmId(db: Db, llmId: string): Promise<void> {
  assertValidLlmId(llmId);
  if ((await readRowById(db, llmId)) === undefined) {
    throw new Error(`그런 LLM 연결이 없습니다: ${llmId}`);
  }
  await setAppState(db, ACTIVE_LLM_STATE_KEY, llmId);
}

/**
 * 실제로 쓸 행을 고른다.
 *
 * 순서: 활성 포인터 → `default` 행 → 가장 먼저 만들어진 행.
 * 마지막 단계가 필요한 이유: 포인터가 가리키는 연결을 지웠거나, 연결이 하나뿐인데
 * id 가 `default` 가 아닌 경우에도 **멈추지 않고** 쓸 수 있어야 한다.
 */
async function readActiveRow(db: Db): Promise<LlmRowRaw | undefined> {
  const active = await getActiveLlmId(db);
  if (active !== null && LLM_ID_PATTERN.test(active)) {
    const row = await readRowById(db, active);
    if (row !== undefined) return row;
  }
  const fallback = await readRowById(db, DEFAULT_LLM_ID);
  if (fallback !== undefined) return fallback;
  return db.get<LlmRowRaw>(
    "SELECT * FROM llm_connections ORDER BY updated_at ASC, llm_id ASC LIMIT 1",
  );
}

export interface LlmConnectionSummary extends LlmConfigMeta {
  readonly llmId: string;
  readonly active: boolean;
}

/** 등록된 연결 전부(민감값 없이) + 어느 것이 활성인가. */
export async function listLlmConnections(db: Db): Promise<LlmConnectionSummary[]> {
  const rows = await db.all<LlmRowRaw>(
    "SELECT * FROM llm_connections ORDER BY updated_at ASC, llm_id ASC",
  );
  if (rows.length === 0) return [];
  const activeRow = await readActiveRow(db);
  return rows.map((row) => ({
    ...rowToMeta(row),
    llmId: row.llm_id,
    active: row.llm_id === activeRow?.llm_id,
  }));
}

function rowToMeta(row: LlmRowRaw): LlmConfigMeta {
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

function readRowById(db: Db, llmId: string): Promise<LlmRowRaw | undefined> {
  return db.get<LlmRowRaw>("SELECT * FROM llm_connections WHERE llm_id = ?", [llmId]);
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
  const row = await readActiveRow(db);
  if (row) return rowToConfig(row);
  return fromEnv();
}

/** 화면용. 민감값 없이. */
export async function getLlmConfigMeta(db: Db): Promise<LlmConfigMeta | null> {
  const row = await readActiveRow(db);
  if (row) return rowToMeta(row);
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

/**
 * 삭제. 없어도 조용히 반환한다.
 *
 * **다른 연결이 있는데 활성 연결을 지우려 하면 거부한다.** 그대로 지우면 활성
 * 포인터가 빈 곳을 가리키고, 요약·번역이 조용히 다른 연결(또는 환경변수)로
 * 넘어간다 — 화면에는 아무 사고도 보이지 않는다. 먼저 활성을 옮기게 한다.
 *
 * 마지막 하나는 지울 수 있다. 그때는 "연결이 없다" 가 분명한 상태이고,
 * 환경변수 폴백으로 내려가는 것이 의도된 동작이다.
 */
export async function deleteLlmConfig(db: Db, llmId: string = DEFAULT_LLM_ID): Promise<void> {
  assertValidLlmId(llmId);
  const total = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM llm_connections");
  const count = Number(total?.n ?? 0);
  const activeRow = await readActiveRow(db);
  if (count > 1 && activeRow?.llm_id === llmId) {
    throw new Error("활성 연결은 지울 수 없습니다. 먼저 다른 연결을 활성으로 바꾸세요.");
  }

  await db.run("DELETE FROM llm_connections WHERE llm_id = ?", [llmId]);

  // 포인터가 지워진 연결을 가리키고 있으면 치운다 — 남겨 두면 "활성인데 없는 연결"
  // 이라는 상태가 되고, 다음 해석이 엉뚱한 행으로 떨어진다.
  if ((await getActiveLlmId(db)) === llmId) {
    await setAppState(db, ACTIVE_LLM_STATE_KEY, "");
  }
}
