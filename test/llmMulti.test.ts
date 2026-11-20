/**
 * LLM 연결을 **여러 개** 두고 그중 하나를 활성으로 쓰는 부분.
 *
 * 이 시험이 지키는 것:
 *   - 활성 전환이 **실제로 호출할 설정**(getLlmConfig)을 바꾼다. 화면 표시만 바뀌면
 *     아무 의미가 없다.
 *   - 없는 연결을 활성으로 만들 수 없다 — 그러면 요약이 조용히 환경변수로 내려간다.
 *   - 활성 연결은 지울 수 없다(다른 연결이 있는 동안). 지워지면 다음 호출이 **엉뚱한
 *     모델**로 나가고 화면에는 아무 사고도 보이지 않는다.
 *   - 연결이 하나뿐이던 시절의 DB(행 id 가 'default', 포인터 없음)가 그대로 돈다.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAppState } from "../lib/appState.ts";
import { openDb, type Db } from "../lib/db.ts";
import {
  ACTIVE_LLM_STATE_KEY,
  DEFAULT_LLM_ID,
  deleteLlmConfig,
  getActiveLlmId,
  getLlmConfig,
  listLlmConnections,
  newLlmId,
  setActiveLlmId,
  upsertLlmConfig,
} from "../lib/llmConfig.ts";

process.env.SR_SECRET_KEY = Buffer.alloc(32, 9).toString("base64");

function freshDb(): Promise<Db> {
  return openDb(join(mkdtempSync(join(tmpdir(), "llmmulti-")), "sr.db"));
}

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  // 환경변수 폴백이 끼어들지 않게 지운다.
  for (const key of ["LLM_BASE_URL", "LLM_MODEL", "LLM_PASSWORD"]) delete process.env[key];
});

const base = {
  baseUrl: "https://llm.ds.lab/api/v1/compatibility/openai",
  authKind: "bearer" as const,
  tokenUrl: "",
  clientId: "",
  authUsername: "",
  secret: "token-value",
  chatPath: "/v1/chat/completions",
  maxTokens: 512,
  temperature: 0.1,
  systemPrompt: "",
};

const conn = (name: string, modelId: string) => ({ ...base, name, modelId });

test("처음 저장한 연결이 자동으로 활성이 된다", async () => {
  // 안 그러면 저장했는데 아무것도 달라지지 않고(요약이 여전히 예전 경로로 간다)
  // 왜 그런지 알 길이 없다.
  const id = await upsertLlmConfig(db, { llmId: newLlmId(), ...conn("첫 연결", "model-a") });
  assert.equal(await getActiveLlmId(db), id);
  assert.equal((await getLlmConfig(db))?.modelId, "model-a");
});

test("두 번째 연결은 활성을 가로채지 않는다", async () => {
  const first = await upsertLlmConfig(db, { llmId: newLlmId(), ...conn("첫", "model-a") });
  await upsertLlmConfig(db, { llmId: newLlmId(), ...conn("둘", "model-b") });

  assert.equal(await getActiveLlmId(db), first, "쓰던 연결이 그대로 활성이어야 한다");
  assert.equal((await getLlmConfig(db))?.modelId, "model-a");
});

test("활성을 바꾸면 실제로 호출할 설정이 바뀐다", async () => {
  await upsertLlmConfig(db, { llmId: "aaa", ...conn("첫", "model-a") });
  await upsertLlmConfig(db, { llmId: "bbb", ...conn("둘", "model-b") });

  await setActiveLlmId(db, "bbb");
  const active = await getLlmConfig(db);
  assert.equal(active?.modelId, "model-b");
  assert.equal(active?.name, "둘");
  assert.equal(active?.secret, "token-value", "복호화된 시크릿도 따라와야 한다");
});

test("목록은 어느 것이 활성인지 알려주고 비밀값은 싣지 않는다", async () => {
  await upsertLlmConfig(db, { llmId: "aaa", ...conn("첫", "model-a") });
  await upsertLlmConfig(db, { llmId: "bbb", ...conn("둘", "model-b") });
  await setActiveLlmId(db, "bbb");

  const list = await listLlmConnections(db);
  assert.equal(list.length, 2);
  assert.deepEqual(
    list.map((c) => [c.llmId, c.active]),
    [["aaa", false], ["bbb", true]],
  );
  assert.ok(list.every((c) => c.hasSecret), "저장 여부는 알려준다");
  assert.ok(
    !JSON.stringify(list).includes("token-value"),
    "평문 시크릿이 목록에 실리면 안 된다",
  );
});

test("없는 연결을 활성으로 만들 수 없다", async () => {
  await upsertLlmConfig(db, { llmId: "aaa", ...conn("첫", "model-a") });
  await assert.rejects(() => setActiveLlmId(db, "does-not-exist"), /그런 LLM 연결이 없습니다/);
  assert.equal(await getActiveLlmId(db), "aaa", "실패한 전환이 포인터를 흔들면 안 된다");
});

test("이상한 id 는 거부한다", async () => {
  await assert.rejects(() => setActiveLlmId(db, "../../etc"), /잘못된 연결 id/);
  await assert.rejects(
    () => upsertLlmConfig(db, { llmId: "has space", ...conn("x", "m") }),
    /잘못된 연결 id/,
  );
});

test("활성 연결은 지울 수 없다 — 먼저 옮기게 한다", async () => {
  await upsertLlmConfig(db, { llmId: "aaa", ...conn("첫", "model-a") });
  await upsertLlmConfig(db, { llmId: "bbb", ...conn("둘", "model-b") });

  await assert.rejects(() => deleteLlmConfig(db, "aaa"), /활성 연결은 지울 수 없습니다/);
  assert.equal((await listLlmConnections(db)).length, 2, "거부된 삭제는 행을 남겨야 한다");

  // 활성을 옮기면 지울 수 있다.
  await setActiveLlmId(db, "bbb");
  await deleteLlmConfig(db, "aaa");
  assert.deepEqual((await listLlmConnections(db)).map((c) => c.llmId), ["bbb"]);
  assert.equal((await getLlmConfig(db))?.modelId, "model-b");
});

test("활성이 아닌 연결은 그냥 지워진다", async () => {
  await upsertLlmConfig(db, { llmId: "aaa", ...conn("첫", "model-a") });
  await upsertLlmConfig(db, { llmId: "bbb", ...conn("둘", "model-b") });
  await deleteLlmConfig(db, "bbb");
  assert.deepEqual((await listLlmConnections(db)).map((c) => c.llmId), ["aaa"]);
});

test("마지막 하나는 지울 수 있고, 포인터도 함께 치운다", async () => {
  await upsertLlmConfig(db, { llmId: "aaa", ...conn("첫", "model-a") });
  await deleteLlmConfig(db, "aaa");

  assert.equal((await listLlmConnections(db)).length, 0);
  assert.equal(await getActiveLlmId(db), null, "없는 연결을 가리키는 포인터를 남기면 안 된다");
  assert.equal(await getAppState(db, ACTIVE_LLM_STATE_KEY), "");
  assert.equal(await getLlmConfig(db), null, "연결이 없으면 null(또는 env 폴백)");
});

test("포인터가 없는 옛 DB — 'default' 행을 쓴다", async () => {
  // 연결이 하나뿐이던 시절의 모양: llm_id='default', app_state 에 포인터 없음.
  await upsertLlmConfig(db, conn("옛 설정", "legacy-model"));
  await db.run("DELETE FROM app_state WHERE key = ?", [ACTIVE_LLM_STATE_KEY]);

  assert.equal(await getActiveLlmId(db), null);
  assert.equal((await getLlmConfig(db))?.modelId, "legacy-model");
  const list = await listLlmConnections(db);
  assert.deepEqual(list.map((c) => [c.llmId, c.active]), [[DEFAULT_LLM_ID, true]]);
});

test("포인터가 사라진 연결을 가리켜도 멈추지 않는다", async () => {
  await upsertLlmConfig(db, { llmId: "aaa", ...conn("첫", "model-a") });
  // 포인터를 손으로 망가뜨린다(지워진 연결을 가리키는 상태).
  await db.run("UPDATE app_state SET value = ? WHERE key = ?", ["gone", ACTIVE_LLM_STATE_KEY]);

  const active = await getLlmConfig(db);
  assert.ok(active !== null, "하나 남은 연결이라도 써야 한다 — 조용히 멈추면 안 된다");
  assert.equal(active.modelId, "model-a");
});
