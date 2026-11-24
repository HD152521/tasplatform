/**
 * 메모 → 노션 페이지.
 *
 * `globalThis.fetch` 를 바꿔 끼워 실제 호출 없이 확인한다. 지키는 것:
 *
 *   1. **설정이 없으면 한 건도 나가지 않는다.** 사내망 도구에서 공개 SaaS 로 글을
 *      보내는 길이다. 꺼진 상태에서 요청이 하나라도 나가면 그게 사고다.
 *   2. **두 번 올려도 페이지는 하나다.** 페이지 id 를 만든 직후에 적는다 — 뒤 블록을
 *      붙이다 실패해도 다음 올리기가 같은 페이지를 찾아야 한다.
 *   3. **지우다 멈추면 새 내용을 붙이지 않는다.** 붙이면 옛 글과 새 글이 섞여 남고,
 *      노션을 열어 봐야 하는 상태인데 아무도 안 열어 본다.
 *   4. **404 는 "공유를 안 했다" 로 읽어 준다.** 노션은 없는 페이지와 권한 없는 페이지를
 *      같은 404 로 답한다. 사유만 보여 주면 사람은 id 를 의심하며 시간을 버린다.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb, type Db } from "../lib/db.ts";
import { createNote, getNote, updateNote } from "../lib/notes.ts";
import { notionReady, publishNoteToNotion } from "../lib/notePublish.ts";
import { normalizePageId } from "../lib/notion.ts";
import { signup } from "../lib/users.ts";

/* ------------------------------------------------------------------ *
 * fetch 바꿔끼우기
 * ------------------------------------------------------------------ */

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: Record<string, unknown> | null;
}

type Handler = (call: Call) => { status: number; body?: unknown };

let calls: Call[] = [];
let handler: Handler;
const realFetch = globalThis.fetch;

function install(next: Handler): void {
  handler = next;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === "string") body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ method, url, body });
    const result = handler({ method, url, body });
    const text = result.body === undefined ? "{}" : JSON.stringify(result.body);
    return new Response(text, { status: result.status });
  }) as typeof globalThis.fetch;
}

function callsTo(fragment: string, method?: string): Call[] {
  return calls.filter(
    (c) => c.url.includes(fragment) && (method === undefined || c.method === method),
  );
}

/* ------------------------------------------------------------------ *
 * 준비
 * ------------------------------------------------------------------ */

let db: Db;
let noteId: number;
const PARENT = "a".repeat(32);

beforeEach(async () => {
  calls = [];
  process.env.NOTION_TOKEN = "secret_test";
  process.env.NOTION_PARENT_PAGE = PARENT;
  process.env.SR_APP_URL = "https://sr.example.lab";

  db = await openDb(join(mkdtempSync(join(tmpdir(), "notes-")), "sr.db"));
  const user = await signup(db, {
    loginId: "yongsik",
    displayName: "안용식",
    password: "hunter2hunter2",
    inviteCode: "",
  });
  noteId = await createNote(db, {
    teamId: "default",
    title: "TAS 업그레이드 사전 점검",
    body: "확인할 것\n- stemcell 버전\n- buildpack 버전",
    createdBy: user.userId,
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  db.close();
});

/* ------------------------------------------------------------------ *
 * 설정
 * ------------------------------------------------------------------ */

test("설정이 없으면 한 건도 나가지 않는다", async () => {
  delete process.env.NOTION_TOKEN;
  install(() => ({ status: 200, body: { id: "x" } }));

  const result = await publishNoteToNotion(db, "default", noteId);
  assert.equal(result.action, "skipped");
  assert.equal(calls.length, 0, "꺼진 상태에서 요청이 나가면 그게 사고다");
  // 실패로 적으면 설정만 안 한 것이 고장으로 보인다.
  assert.equal((await getNote(db, "default", noteId))?.notionState, "none");
});

test("부모 페이지가 없으면 설정이 안 된 것으로 본다", () => {
  delete process.env.NOTION_PARENT_PAGE;
  assert.equal(notionReady(), false);
});

test("노션 주소를 그대로 붙여 넣어도 id 를 찾아낸다", () => {
  // 사람이 주소를 붙여 넣는 일이 흔하다. 그대로 보내면 404 가 오고, 그 404 는
  // "공유를 안 했다" 와 구분이 안 된다.
  const id = "1a2b3c4d5e6f7890abcdef1234567890";
  assert.equal(normalizePageId(`https://www.notion.so/team/점검-${id}?pvs=4`), id);
  assert.equal(normalizePageId("1a2b3c4d-5e6f-7890-abcd-ef1234567890"), id);
  assert.equal(normalizePageId("그냥 글자"), "");
});

/* ------------------------------------------------------------------ *
 * 처음 올리기
 * ------------------------------------------------------------------ */

test("처음 올리면 부모 아래에 페이지를 만들고 주소를 적어 둔다", async () => {
  install(() => ({ status: 200, body: { id: "page-1", url: "https://notion.so/page-1" } }));

  const result = await publishNoteToNotion(db, "default", noteId);
  assert.equal(result.action, "created");

  const post = callsTo("/v1/pages", "POST")[0];
  assert.equal((post?.body?.parent as { page_id?: string })?.page_id, PARENT);
  assert.match(JSON.stringify(post?.body), /TAS 업그레이드 사전 점검/);
  // 목록으로 올라가야 한다 — `-` 글자로 남으면 정리해서 올린 것이 아니다.
  assert.match(JSON.stringify(post?.body), /bulleted_list_item/);

  const note = await getNote(db, "default", noteId);
  assert.equal(note?.notionPageId, "page1");
  assert.equal(note?.notionUrl, "https://notion.so/page-1");
  assert.equal(note?.notionState, "ok");
});

test("토큰과 API 버전을 헤더로 보낸다", async () => {
  let seen: Record<string, string> = {};
  handler = () => ({ status: 200, body: { id: "page-1" } });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method: "POST", url: String(input), body: null });
    return new Response(JSON.stringify({ id: "page-1" }), { status: 200 });
  }) as typeof globalThis.fetch;

  await publishNoteToNotion(db, "default", noteId);
  assert.equal(seen.Authorization, "Bearer secret_test");
  assert.ok((seen["Notion-Version"] ?? "") !== "", "버전을 안 보내면 노션이 거절한다");
});

test("응답에 페이지 id 가 없으면 실패로 적는다", async () => {
  // id 가 없으면 다음 올리기가 그 페이지를 못 찾아 같은 글로 하나 더 만든다.
  install(() => ({ status: 200, body: { url: "https://notion.so/x" } }));

  const result = await publishNoteToNotion(db, "default", noteId);
  assert.equal(result.action, "failed");
  assert.equal((await getNote(db, "default", noteId))?.notionState, "failed");
});

/* ------------------------------------------------------------------ *
 * 다시 올리기
 * ------------------------------------------------------------------ */

test("다시 올리면 페이지를 더 만들지 않고 내용을 바꾼다", async () => {
  install((call) => {
    if (call.url.includes("/v1/pages") && call.method === "POST") {
      return { status: 200, body: { id: "page-1", url: "https://notion.so/page-1" } };
    }
    if (call.url.includes("/children") && call.method === "GET") {
      return { status: 200, body: { results: [{ id: "b1" }, { id: "b2" }], has_more: false } };
    }
    return { status: 200, body: {} };
  });

  await publishNoteToNotion(db, "default", noteId);
  await updateNote(db, "default", noteId, { body: "확인할 것\n- stemcell 버전만" });
  calls = [];

  const result = await publishNoteToNotion(db, "default", noteId);
  assert.equal(result.action, "updated");
  assert.equal(callsTo("/v1/pages", "POST").length, 0, "페이지를 두 번 만들면 안 된다");
  // 옛 블록을 지우고 새로 붙인다 — 노션에는 '내용 통째로 바꾸기' 가 없다.
  assert.equal(callsTo("/v1/blocks/b1", "DELETE").length, 1);
  assert.equal(callsTo("/v1/blocks/b2", "DELETE").length, 1);
  assert.equal(callsTo("/children", "PATCH").length, 1);
  assert.match(JSON.stringify(callsTo("/children", "PATCH")[0]?.body), /stemcell 버전만/);
});

test("제목을 고치면 노션 페이지 제목도 따라간다", async () => {
  install((call) =>
    call.url.includes("/v1/pages") && call.method === "POST"
      ? { status: 200, body: { id: "page-1" } }
      : { status: 200, body: { results: [], has_more: false } },
  );
  await publishNoteToNotion(db, "default", noteId);
  await updateNote(db, "default", noteId, { title: "사전 점검 (수정)" });
  calls = [];

  await publishNoteToNotion(db, "default", noteId);
  assert.match(JSON.stringify(callsTo("/v1/pages/page1", "PATCH")[0]?.body), /사전 점검 \(수정\)/);
});

test("지우다 멈추면 새 내용을 붙이지 않고 그렇게 말한다", async () => {
  install((call) => {
    if (call.url.includes("/v1/pages") && call.method === "POST") {
      return { status: 200, body: { id: "page-1" } };
    }
    if (call.url.includes("/children") && call.method === "GET") {
      return { status: 200, body: { results: [{ id: "b1" }, { id: "b2" }], has_more: false } };
    }
    if (call.method === "DELETE") {
      return call.url.includes("b1") ? { status: 200, body: {} } : { status: 500, body: {} };
    }
    return { status: 200, body: {} };
  });

  await publishNoteToNotion(db, "default", noteId);
  calls = [];
  const result = await publishNoteToNotion(db, "default", noteId);

  assert.equal(result.action, "failed");
  assert.match(result.message, /지우다 멈췄습니다/);
  assert.match(result.message, /1\/2/);
  // 붙이면 옛 글과 새 글이 섞여 남는다.
  assert.equal(callsTo("/children", "PATCH").length, 0);
  assert.equal((await getNote(db, "default", noteId))?.notionState, "failed");
});

/* ------------------------------------------------------------------ *
 * 실패 읽어 주기
 * ------------------------------------------------------------------ */

test("404 는 '공유를 안 했다' 로 읽어 준다", async () => {
  install(() => ({ status: 404, body: { message: "Could not find page" } }));

  const result = await publishNoteToNotion(db, "default", noteId);
  assert.equal(result.action, "failed");
  assert.match(result.message, /공유했는지/);
});

test("401 은 토큰 문제로 읽어 준다", async () => {
  install(() => ({ status: 401, body: {} }));
  assert.match((await publishNoteToNotion(db, "default", noteId)).message, /토큰/);
});

test("망에 못 닿으면 나가는 길을 의심하라고 말한다", async () => {
  // 사내망에서 api.notion.com 으로 나가는 길이 막혀 있을 수 있다 — 그게 첫 의심이다.
  globalThis.fetch = (async () => {
    throw new Error("getaddrinfo ENOTFOUND api.notion.com");
  }) as typeof globalThis.fetch;

  const result = await publishNoteToNotion(db, "default", noteId);
  assert.equal(result.action, "failed");
  assert.match(result.message, /api\.notion\.com/);
});

test("실패를 세고, 성공하면 0 으로 되돌린다", async () => {
  install(() => ({ status: 500, body: {} }));
  await publishNoteToNotion(db, "default", noteId);
  await publishNoteToNotion(db, "default", noteId);
  assert.equal((await getNote(db, "default", noteId))?.notionTries, 2);

  install(() => ({ status: 200, body: { id: "page-1" } }));
  await publishNoteToNotion(db, "default", noteId);
  const note = await getNote(db, "default", noteId);
  assert.equal(note?.notionTries, 0);
  assert.equal(note?.notionError, "");
});

test("실패해도 한 번 받은 페이지 주소를 잃지 않는다", async () => {
  install(() => ({ status: 200, body: { id: "page-1", url: "https://notion.so/page-1" } }));
  await publishNoteToNotion(db, "default", noteId);

  install(() => ({ status: 500, body: {} }));
  await publishNoteToNotion(db, "default", noteId);

  const note = await getNote(db, "default", noteId);
  // 주소를 빈 값으로 덮으면 다음 올리기가 페이지를 하나 더 만든다.
  assert.equal(note?.notionPageId, "page1");
  assert.equal(note?.notionUrl, "https://notion.so/page-1");
});

test("없는 메모는 아무것도 하지 않는다", async () => {
  install(() => ({ status: 200, body: { id: "x" } }));
  const result = await publishNoteToNotion(db, "default", 99999);
  assert.equal(result.action, "skipped");
  assert.equal(calls.length, 0);
});
