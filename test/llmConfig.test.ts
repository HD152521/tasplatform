/**
 * LLM 연결 설정 저장·조회.
 *
 * 비밀번호가 암호화돼 저장되는지, 화면용이 평문을 흘리지 않는지, 빈 값이 기존을 유지하는지,
 * DB 가 비면 환경변수로 폴백하는지 — 여기가 틀리면 비밀번호가 새거나 설정이 사라진다.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../lib/db.ts";
import {
  deleteLlmConfig,
  getLlmConfig,
  getLlmConfigMeta,
  upsertLlmConfig,
} from "../lib/llmConfig.ts";

// 암호화 키(32바이트). 없으면 저장이 거부되므로 반드시 세팅한다.
process.env.SR_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");

function freshDb(): Promise<Db> {
  const file = join(mkdtempSync(join(tmpdir(), "llmcfg-")), "sr.db");
  return openDb(file);
}

const base = {
  name: "기본 LLM",
  modelId: "google/gemma-4-31b-it",
  baseUrl: "https://pais.ds.lab/api/v1/compatibility/openai",
  authKind: "keycloak" as const,
  tokenUrl: "https://pai-keycloak.ds.lab/realms/pais/protocol/openid-connect/token",
  clientId: "pais-client",
  authUsername: "pais-admin",
  secret: "s3cret",
  chatPath: "/v1/chat/completions",
  maxTokens: 512,
  temperature: 0.1,
  systemPrompt: "한국어로 답하라.",
};

// 환경변수 폴백 테스트가 다른 테스트를 오염시키지 않도록 매번 지운다.
beforeEach(() => {
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
  delete process.env.LLM_PASSWORD;
});

test("저장한 설정을 복호화해 되읽는다 (왕복)", async () => {
  const db = await freshDb();
  await upsertLlmConfig(db, base);
  const got = await getLlmConfig(db);
  assert.ok(got);
  assert.equal(got.modelId, "google/gemma-4-31b-it");
  assert.equal(got.secret, "s3cret");
  assert.equal(got.source, "db");
  await db.close();
});

test("DB 에는 평문 비밀번호가 저장되지 않는다", async () => {
  const db = await freshDb();
  await upsertLlmConfig(db, base);
  const row = await db.get<{ secret_enc: string }>("SELECT secret_enc FROM llm_connections WHERE llm_id='default'");
  assert.ok(row);
  assert.ok(row.secret_enc.startsWith("v1:"));
  assert.ok(!row.secret_enc.includes("s3cret"));
  await db.close();
});

test("화면용(meta)은 비밀번호를 노출하지 않고 존재 여부만 준다", async () => {
  const db = await freshDb();
  await upsertLlmConfig(db, base);
  const meta = await getLlmConfigMeta(db);
  assert.ok(meta);
  assert.equal(meta.hasSecret, true);
  assert.equal((meta as unknown as { secret?: string }).secret, undefined);
  await db.close();
});

test("비밀번호를 비워 수정하면 기존 값이 유지된다", async () => {
  const db = await freshDb();
  await upsertLlmConfig(db, base);
  await upsertLlmConfig(db, { ...base, name: "이름만 변경", secret: "" });
  const got = await getLlmConfig(db);
  assert.equal(got?.name, "이름만 변경");
  assert.equal(got?.secret, "s3cret");
  await db.close();
});

test("keycloak 인데 토큰 URL 이 없으면 거부한다", async () => {
  const db = await freshDb();
  await assert.rejects(upsertLlmConfig(db, { ...base, tokenUrl: "" }), /토큰 발급 URL/);
  await db.close();
});

test("http base_url 은 거부한다 (https 만)", async () => {
  const db = await freshDb();
  await assert.rejects(upsertLlmConfig(db, { ...base, baseUrl: "http://pais.ds.lab" }), /https/);
  await db.close();
});

test("모델 ID 가 비면 거부한다", async () => {
  const db = await freshDb();
  await assert.rejects(upsertLlmConfig(db, { ...base, modelId: "" }), /모델 ID/);
  await db.close();
});

test("DB 가 비면 환경변수(LLM_*)로 폴백한다", async () => {
  const db = await freshDb();
  assert.equal(await getLlmConfig(db), null);

  process.env.LLM_BASE_URL = "https://pais.ds.lab/api/v1/compatibility/openai";
  process.env.LLM_MODEL = "google/gemma-4-31b-it";
  process.env.LLM_PASSWORD = "envpass";
  const got = await getLlmConfig(db);
  assert.ok(got);
  assert.equal(got.source, "env");
  assert.equal(got.modelId, "google/gemma-4-31b-it");
  assert.equal(got.secret, "envpass");
  await db.close();
});

test("DB 설정이 있으면 환경변수보다 우선한다", async () => {
  const db = await freshDb();
  await upsertLlmConfig(db, base);
  process.env.LLM_BASE_URL = "https://other.ds.lab/openai";
  process.env.LLM_MODEL = "env-model";
  const got = await getLlmConfig(db);
  assert.equal(got?.source, "db");
  assert.equal(got?.modelId, "google/gemma-4-31b-it");
  await db.close();
});

test("삭제하면 다시 null (또는 env 폴백)", async () => {
  const db = await freshDb();
  await upsertLlmConfig(db, base);
  await deleteLlmConfig(db);
  assert.equal(await getLlmConfig(db), null);
  await db.close();
});
