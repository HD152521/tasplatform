/**
 * 캘린더 일정 → Jira 이슈. **이 레포에서 Jira 쓰기 경로를 처음 시험하는 파일이다.**
 *
 * `globalThis.fetch` 를 바꿔 끼워 실제 호출 없이 확인한다. 지키는 것:
 *
 *   1. **멱등** — 타임아웃이 나도 이슈가 하나다. "만들어졌는지 모름" 상태는 멱등
 *      라벨로 찾아 입양한다. 이게 깨지면 일정 하나에 이슈가 둘 생긴다.
 *   2. **400 폴백** — 커스텀필드·담당자 모양이 인스턴스마다 달라 400 이 난다.
 *      그때 곁가지 칸을 떼고 이슈는 반드시 만든다.
 *   3. **상태 전이** — 맞는 전이가 없으면 **아무것도 하지 않고** 사유를 남긴다.
 *      추측해서 엉뚱한 상태로 밀지 않는다.
 *   4. **삭제** — 404 는 성공(이미 없는 것이 목표), 403 은 코멘트로 대신하고
 *      "남아 있다" 고 알린다.
 *   5. **Jira 가 꺼져 있거나 죽어 있어도 캘린더는 동작한다.**
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEvent, getEvent, updateEvent } from "../lib/calendar.ts";
import {
  eventLabel,
  removeEventFromJira,
  syncEventToJira,
  syncPendingEvents,
  transitionNames,
} from "../lib/calendarJira.ts";
import { openDb, type Db } from "../lib/db.ts";
import { signup } from "../lib/users.ts";

/* ------------------------------------------------------------------ *
 * fetch 바꿔끼우기
 * ------------------------------------------------------------------ */

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: Record<string, unknown> | null;
}

type Handler = (call: Call) => { status: number; body?: unknown } | Promise<never>;

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
    const call: Call = { method, url, body };
    calls.push(call);

    const result = await handler(call);
    // 204·205·304 는 **본문을 가질 수 없다.** 빈 문자열이라도 넘기면 Response 생성자가
    // 던지고, 그 예외가 "Jira 에 닿지 못했다" 로 둔갑한다(실제 실패와 구분이 안 된다).
    const bodyless = result.status === 204 || result.status === 205 || result.status === 304;
    const text = result.body === undefined || bodyless ? null : JSON.stringify(result.body);
    return new Response(text, { status: result.status });
  }) as typeof globalThis.fetch;
}

/** 주어진 경로를 지나간 호출만. */
function callsTo(fragment: string, method?: string): Call[] {
  return calls.filter(
    (c) => c.url.includes(fragment) && (method === undefined || c.method === method),
  );
}

/* ------------------------------------------------------------------ *
 * 준비
 * ------------------------------------------------------------------ */

let db: Db;
let userId: number;
let eventId: number;

beforeEach(async () => {
  calls = [];
  // Jira 자동 등록을 켠다. 값은 전부 가짜다 — 실제 호출은 나가지 않는다.
  process.env.JIRA_AUTO_CREATE = "1";
  process.env.ATLASSIAN_BASE = "https://jira.test";
  process.env.ATLASSIAN_EMAIL = "bot@example.com";
  process.env.ATLASSIAN_TOKEN = "token";
  process.env.JIRA_SR_PROJECT = "ABC";
  process.env.JIRA_SR_ISSUETYPE = "작업";
  delete process.env.JIRA_SR_EPIC;
  delete process.env.JIRA_SR_TEAM_ID;
  delete process.env.JIRA_TR_DONE;

  db = await openDb(join(mkdtempSync(join(tmpdir(), "caljira-")), "sr.db"));
  const user = await signup(db, {
    loginId: "yongsik",
    displayName: "안용식",
    password: "hunter2hunter2",
    inviteCode: "",
  });
  userId = user.userId;
  await db.run("UPDATE users SET jira_account_id = ? WHERE user_id = ?", ["acct-1", userId]);

  eventId = await createEvent(db, {
    teamId: "default",
    title: "방화벽 점검",
    kind: "점검",
    startDate: "2126-11-25",
    endDate: "2126-11-27",
    assigneeUserId: userId,
    assigneeLabel: "용식",
    createdBy: userId,
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 생성 요청의 fields. */
function createdFields(): Record<string, unknown> {
  const create = callsTo("/rest/api/3/issue", "POST").filter((c) => !c.url.includes("/comment"));
  const last = create[create.length - 1];
  return (last?.body?.fields ?? {}) as Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * 생성
 * ------------------------------------------------------------------ */

test("일정을 올리면 이슈가 하나 만들어진다", async () => {
  install(() => ({ status: 201, body: { key: "ABC-10" } }));

  const result = await syncEventToJira(db, "default", eventId);
  assert.equal(result.action, "created");
  assert.equal(result.issueKey, "ABC-10");
  assert.equal(result.state, "ok");

  const event = await getEvent(db, "default", eventId);
  assert.equal(event?.jiraKey, "ABC-10");
  assert.equal(event?.jiraState, "ok");
  assert.equal(event?.jiraUrl, "https://jira.test/browse/ABC-10");
});

test("생성 요청에 멱등 라벨·기간·담당자가 실린다", async () => {
  install(() => ({ status: 201, body: { key: "ABC-10" } }));
  await syncEventToJira(db, "default", eventId);

  const fields = createdFields();
  // 대괄호는 **전산망** 자리다(이 팀 양식). 성격 태그(점검)는 거기 들어가지 않는다.
  assert.equal(fields.summary, "방화벽 점검");
  assert.deepEqual(fields.project, { key: "ABC" });
  assert.equal(fields.duedate, "2126-11-27", "종료일이 기한으로 들어가야 한다");
  assert.equal(fields.customfield_10015, "2126-11-25", "시작일 커스텀필드");
  assert.deepEqual(fields.assignee, { accountId: "acct-1" });

  const labels = fields.labels as string[];
  assert.ok(labels.includes(eventLabel(eventId)), "멱등 라벨이 없으면 중복 이슈를 막을 수 없다");
  assert.ok(labels.includes("SRHUB_CAL"));
  assert.ok(labels.includes("TAS_작업지원"), "업무 성격은 사내 라벨로 간다");
});

test("본문에 등록자를 적는다 — reporter 는 공용 계정이라 이게 유일한 기록이다", async () => {
  // 토큰 하나로 쓰므로 Jira 의 reporter 는 전원 같은 계정이 된다. 본문에 등록자가
  // 없으면 목록만 훑는 사람은 누가 올린 일정인지 알 길이 없다.
  install(() => ({ status: 201, body: { key: "ABC-10" } }));
  await syncEventToJira(db, "default", eventId);

  const description = JSON.stringify(createdFields().description);
  // 괄호가 든 문구라 정규식 대신 글자로 본다(이스케이프 실수로 조용히 통과하지 않게).
  assert.ok(description.includes("등록: 안용식 (앱 사용자)"), description);
});

test("본문의 담당자는 맞춰진 팀원의 '지금 이름' 이다", async () => {
  // 일정에 적힌 글자는 "용식" 이지만 팀원 이름은 "안용식" 이다. accountId 가 없어
  // 담당자 칸을 비울 때 본문의 이 줄이 유일한 단서라, 정확한 이름이어야 한다.
  install(() => ({ status: 201, body: { key: "ABC-10" } }));
  await syncEventToJira(db, "default", eventId);

  const description = JSON.stringify(createdFields().description);
  assert.match(description, /담당: 안용식/);
});

test("담당자를 못 맞췄으면 적어 둔 글자를 본문에 쓴다", async () => {
  const loose = await createEvent(db, {
    teamId: "default",
    title: "VCF 패치",
    startDate: "2126-12-05",
    assigneeUserId: null,
    assigneeLabel: "민수",
    createdBy: userId,
  });
  install(() => ({ status: 201, body: { key: "ABC-13" } }));
  await syncEventToJira(db, "default", loose);

  const description = JSON.stringify(createdFields().description);
  assert.match(description, /담당: 민수/, "조용히 '미지정' 으로 두면 적은 사람이 모른다");
});

test("담당자의 Jira 계정이 없으면 담당자 없이 올린다", async () => {
  await db.run("UPDATE users SET jira_account_id = '' WHERE user_id = ?", [userId]);
  install(() => ({ status: 201, body: { key: "ABC-11" } }));

  const result = await syncEventToJira(db, "default", eventId);
  assert.equal(result.action, "created", "담당자 없이라도 이슈는 올라가야 한다");
  assert.equal(createdFields().assignee, undefined);
});

test("400 이면 곁가지 칸을 떼고 이슈는 반드시 만든다", async () => {
  // 커스텀필드 id·담당자 모양은 인스턴스마다 다르다. 그것 때문에 이슈가 아예 안
  // 생기면 추적할 곳이 없어진다.
  let first = true;
  install(() => {
    if (first) {
      first = false;
      return { status: 400, body: { errors: { customfield_10015: "Field does not exist" } } };
    }
    return { status: 201, body: { key: "ABC-12" } };
  });

  const result = await syncEventToJira(db, "default", eventId);
  assert.equal(result.action, "created");
  assert.equal(result.issueKey, "ABC-12");
  assert.ok(result.dropped.includes("duedate"));
  assert.equal(callsTo("/rest/api/3/issue", "POST").length, 2, "한 번만 다시 시도한다");

  // 라벨이 떨어졌으면 멱등 장치가 없는 이슈다 — 그 사실을 분명히 말해야 한다.
  assert.match(result.message, /멱등 라벨이 들어가지 않았습니다/);
});

/* ------------------------------------------------------------------ *
 * 사내 양식 — 제목 대괄호(망) · 상위 에픽(법인) · 라벨(성격)
 *
 * 세 자리가 서로 다른 것을 담는다. 하나라도 엉뚱하게 넣으면 보고서 집계
 * (lib/jira.ts)가 그 건을 놓치거나 다른 법인으로 센다.
 * ------------------------------------------------------------------ */

/** 망·법인을 넣은 일정 하나. */
async function eventWith(fields: { scopes?: string; corp?: string; kind?: string }): Promise<number> {
  return createEvent(db, {
    teamId: "default",
    title: "10월 정기 점검",
    kind: fields.kind ?? "",
    scopes: fields.scopes ?? "",
    corp: fields.corp ?? "",
    startDate: "2126-12-10",
    createdBy: userId,
  });
}

test("망이 제목 앞 대괄호가 된다", async () => {
  const id = await eventWith({ scopes: "개발/운영/DR" });
  install(() => ({ status: 201, body: { key: "ABC-30" } }));
  await syncEventToJira(db, "default", id);
  assert.equal(createdFields().summary, "[개발/운영/DR] 10월 정기 점검");
});

test("망 순서는 적은 순서가 아니라 정해진 순서다", async () => {
  // 같은 조합이 [개발/운영/DR] 과 [운영/개발/DR] 로 갈려 있으면 눈으로 묶이지 않는다.
  const id = await eventWith({ scopes: "DR/운영/개발" });
  install(() => ({ status: 201, body: { key: "ABC-31" } }));
  await syncEventToJira(db, "default", id);
  assert.equal(createdFields().summary, "[개발/운영/DR] 10월 정기 점검");
});

test("법인이 상위 에픽을 고른다", async () => {
  process.env.JIRA_EPIC_BANK = "EPIC-BANK";
  process.env.JIRA_EPIC_CENTRAL = "EPIC-CENT";

  const bank = await eventWith({ scopes: "운영", corp: "은행" });
  install(() => ({ status: 201, body: { key: "ABC-32" } }));
  await syncEventToJira(db, "default", bank);
  assert.deepEqual(createdFields().parent, { key: "EPIC-BANK" });

  calls = [];
  const central = await eventWith({ scopes: "운영", corp: "중앙회" });
  install(() => ({ status: 201, body: { key: "ABC-33" } }));
  await syncEventToJira(db, "default", central);
  assert.deepEqual(createdFields().parent, { key: "EPIC-CENT" });
});

test("법인 에픽 설정이 없으면 기본 에픽에 달고 그 사실을 말한다", async () => {
  // 조용히 다른 법인 에픽에 달리면 보고서가 엉뚱한 법인으로 센다.
  delete process.env.JIRA_EPIC_CENTRAL;
  process.env.JIRA_SR_EPIC = "EPIC-FALLBACK";

  const id = await eventWith({ scopes: "운영", corp: "중앙회" });
  install(() => ({ status: 201, body: { key: "ABC-34" } }));
  const result = await syncEventToJira(db, "default", id);

  assert.deepEqual(createdFields().parent, { key: "EPIC-FALLBACK" });
  assert.match(result.message, /JIRA_EPIC_CENTRAL/);
});

test("본사는 망이 없어도 대괄호에 본사가 들어간다", async () => {
  // 실제로 [본사] 가 91건이다.
  process.env.JIRA_EPIC_HQ = "EPIC-HQ";
  const id = await eventWith({ corp: "본사" });
  install(() => ({ status: 201, body: { key: "ABC-35" } }));
  await syncEventToJira(db, "default", id);

  assert.equal(createdFields().summary, "[본사] 10월 정기 점검");
  assert.deepEqual(createdFields().parent, { key: "EPIC-HQ" });
});

test("은행·중앙회는 제목에 넣지 않는다", async () => {
  const id = await eventWith({ corp: "은행" });
  install(() => ({ status: 201, body: { key: "ABC-36" } }));
  await syncEventToJira(db, "default", id);
  assert.equal(createdFields().summary, "10월 정기 점검");
});

test("업무 성격이 사내 라벨이 된다", async () => {
  const id = await eventWith({ scopes: "운영", kind: "장애" });
  install(() => ({ status: 201, body: { key: "ABC-37" } }));
  await syncEventToJira(db, "default", id);

  const labels = createdFields().labels as string[];
  assert.ok(labels.includes("TAS_장애대응"));
  assert.ok(!labels.includes("TAS_작업지원"), "둘이 함께 붙으면 집계가 겹친다");
});

test("본문에 전산망·법인이 적힌다", async () => {
  const id = await eventWith({ scopes: "개발/운영", corp: "은행", kind: "점검" });
  install(() => ({ status: 201, body: { key: "ABC-38" } }));
  await syncEventToJira(db, "default", id);

  const description = JSON.stringify(createdFields().description);
  assert.ok(description.includes("전산망: 개발 / 운영"), description);
  assert.ok(description.includes("법인: 은행"), description);
  assert.ok(description.includes("업무: 점검"), description);
});

/* ------------------------------------------------------------------ *
 * 멘션 — 글자로 두면 알림이 가지 않는다
 * ------------------------------------------------------------------ */

test("본문의 @이름이 실제 Jira 멘션이 된다", async () => {
  const id = await createEvent(db, {
    teamId: "default",
    title: "패치 작업",
    body: "@안용식 확인 부탁드립니다",
    startDate: "2126-12-11",
    createdBy: userId,
  });
  install(() => ({ status: 201, body: { key: "ABC-40" } }));
  await syncEventToJira(db, "default", id);

  const description = JSON.stringify(createdFields().description);
  assert.ok(description.includes('"type":"mention"'), description);
  assert.ok(description.includes('"id":"acct-1"'), "accountId 가 들어가야 알림이 간다");
});

test("Jira 계정이 없는 사람은 글자로 남고 결과가 그 사실을 말한다", async () => {
  await db.run("UPDATE users SET jira_account_id = '' WHERE user_id = ?", [userId]);
  const id = await createEvent(db, {
    teamId: "default",
    title: "패치 작업",
    body: "@안용식 확인 부탁",
    startDate: "2126-12-12",
    createdBy: userId,
  });
  install(() => ({ status: 201, body: { key: "ABC-41" } }));
  const result = await syncEventToJira(db, "default", id);

  const description = JSON.stringify(createdFields().description);
  assert.ok(!description.includes('"type":"mention"'));
  assert.ok(description.includes("@안용식"), "이름을 지우면 누구 얘기였는지 잃는다");
  assert.match(result.message, /Jira 계정이 연결되지 않아/);
});

/* ------------------------------------------------------------------ *
 * 멱등 — 이 파일의 핵심
 * ------------------------------------------------------------------ */

test("타임아웃이면 '만들어졌는지 모름' 으로 남긴다", async () => {
  install(() => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    return Promise.reject(error);
  });

  const result = await syncEventToJira(db, "default", eventId);
  assert.equal(result.action, "failed");
  assert.equal(result.state, "unknown", "'거절' 로 적으면 다음 시도가 이슈를 하나 더 만든다");

  const event = await getEvent(db, "default", eventId);
  assert.equal(event?.jiraState, "unknown");
  assert.equal(event?.jiraTries, 1);
  assert.match(event?.jiraError ?? "", /라벨로 찾아 연결/);
});

test("타임아웃 뒤 재시도는 라벨로 찾아 입양한다 — 이슈가 둘 생기지 않는다", async () => {
  // 1회차: 타임아웃.
  install(() => {
    const error = new Error("timeout");
    error.name = "TimeoutError";
    return Promise.reject(error);
  });
  await syncEventToJira(db, "default", eventId);
  calls = [];

  // 2회차: 라벨 조회에서 이미 만들어진 이슈가 나온다.
  install((call) => {
    if (call.url.includes("/search/jql")) {
      return { status: 200, body: { issues: [{ key: "ABC-99" }] } };
    }
    if (call.method === "PUT") return { status: 204 };
    return { status: 201, body: { key: "ABC-NEW" } };
  });

  const result = await syncEventToJira(db, "default", eventId);
  assert.equal(result.action, "adopted");
  assert.equal(result.issueKey, "ABC-99");
  assert.equal(
    callsTo("/rest/api/3/issue", "POST").length,
    0,
    "이미 있는 이슈를 두고 또 만들면 안 된다",
  );

  const search = callsTo("/search/jql")[0];
  assert.ok(search !== undefined);
  assert.ok(
    decodeURIComponent(search.url).includes(`labels = "${eventLabel(eventId)}"`),
    "일정 고유 라벨로 찾아야 한다",
  );

  const event = await getEvent(db, "default", eventId);
  assert.equal(event?.jiraKey, "ABC-99");
  assert.equal(event?.jiraState, "ok");
});

test("라벨 조회가 실패하면 새로 만들지 않는다", async () => {
  install(() => {
    const error = new Error("timeout");
    error.name = "TimeoutError";
    return Promise.reject(error);
  });
  await syncEventToJira(db, "default", eventId);
  calls = [];

  // 조회 자체가 터진다. "없다" 로 뭉개면 두 번째 이슈가 생긴다.
  install((call) => {
    if (call.url.includes("/search/jql")) return { status: 503 };
    return { status: 201, body: { key: "ABC-DUP" } };
  });

  const result = await syncEventToJira(db, "default", eventId);
  assert.equal(result.action, "failed");
  assert.equal(callsTo("/rest/api/3/issue", "POST").length, 0);
  assert.equal((await getEvent(db, "default", eventId))?.jiraState, "unknown");
});

test("이미 키가 있으면 생성이 아니라 수정이다", async () => {
  install(() => ({ status: 201, body: { key: "ABC-10" } }));
  await syncEventToJira(db, "default", eventId);
  calls = [];

  install(() => ({ status: 204 }));
  const result = await syncEventToJira(db, "default", eventId);
  assert.equal(result.action, "updated");
  assert.equal(callsTo("/rest/api/3/issue", "POST").length, 0);
  assert.equal(callsTo("/rest/api/3/issue/ABC-10", "PUT").length, 1);
});

test("반복 실패는 상한에서 멈춘다", async () => {
  install(() => ({ status: 400, body: { errors: { project: "no such project" } } }));

  // 400 은 폴백까지 두 번 시도하고 거절로 끝난다. 다섯 번 쌓이면 멈춘다.
  for (let i = 0; i < 5; i += 1) await syncEventToJira(db, "default", eventId);
  calls = [];

  const result = await syncEventToJira(db, "default", eventId);
  assert.equal(result.action, "skipped");
  assert.match(result.message, /멈췄습니다/);
  assert.equal(calls.length, 0, "상한에 닿으면 Jira 를 더 때리지 않는다");

  // 사람이 「다시 시도」를 누르면(force) 한 번 더 한다.
  install(() => ({ status: 201, body: { key: "ABC-20" } }));
  const forced = await syncEventToJira(db, "default", eventId, { force: true });
  assert.equal(forced.action, "created");
});

/* ------------------------------------------------------------------ *
 * 수정 · 상태 전이
 * ------------------------------------------------------------------ */

test("수정은 제목·기간·담당자를 갱신한다", async () => {
  install(() => ({ status: 201, body: { key: "ABC-10" } }));
  await syncEventToJira(db, "default", eventId);
  calls = [];

  await updateEvent(db, "default", eventId, { title: "방화벽 룰 정리", endDate: "2126-11-30" });
  install(() => ({ status: 204 }));
  await syncEventToJira(db, "default", eventId);

  const put = callsTo("/rest/api/3/issue/ABC-10", "PUT")[0];
  const fields = (put?.body?.fields ?? {}) as Record<string, unknown>;
  assert.equal(fields.summary, "방화벽 룰 정리");
  assert.equal(fields.duedate, "2126-11-30");
  assert.ok(put?.url.includes("notifyUsers=false"), "같은 소식을 두 번 알리지 않는다");
});

test("담당자를 비우면 Jira 담당자도 비운다", async () => {
  install(() => ({ status: 201, body: { key: "ABC-10" } }));
  await syncEventToJira(db, "default", eventId);
  calls = [];

  await updateEvent(db, "default", eventId, { assigneeUserId: null, assigneeLabel: "" });
  install(() => ({ status: 204 }));
  await syncEventToJira(db, "default", eventId);

  const fields = (callsTo("/rest/api/3/issue/ABC-10", "PUT")[0]?.body?.fields ?? {}) as Record<string, unknown>;
  assert.equal(fields.assignee, null, "옛 담당자가 남으면 그 사람이 계속 알림을 받는다");
});

test("notifyUsers 가 거부되면 플래그를 떼고 다시 보낸다", async () => {
  install(() => ({ status: 201, body: { key: "ABC-10" } }));
  await syncEventToJira(db, "default", eventId);
  calls = [];

  install((call) => {
    if (call.method === "PUT" && call.url.includes("notifyUsers=false")) return { status: 400 };
    return { status: 204 };
  });
  const result = await syncEventToJira(db, "default", eventId);
  assert.equal(result.action, "updated");
  assert.equal(callsTo("/rest/api/3/issue/ABC-10", "PUT").length, 2);
});

test("상태가 바뀌면 전이를 실행한다", async () => {
  install(() => ({ status: 201, body: { key: "ABC-10" } }));
  await syncEventToJira(db, "default", eventId);
  calls = [];

  await updateEvent(db, "default", eventId, { state: "done" });
  install((call) => {
    if (call.url.includes("/transitions") && call.method === "GET") {
      return {
        status: 200,
        body: {
          transitions: [
            { id: "11", name: "진행 중", to: { name: "In Progress" } },
            { id: "21", name: "완료", to: { name: "Done" } },
          ],
        },
      };
    }
    return { status: 204 };
  });

  const result = await syncEventToJira(db, "default", eventId, { stateChanged: true });
  assert.match(result.message, /「완료」/);

  const posted = callsTo("/transitions", "POST")[0];
  assert.deepEqual(posted?.body, { transition: { id: "21" } });
});

test("도착 상태 이름으로도 전이를 찾는다", async () => {
  install(() => ({ status: 201, body: { key: "ABC-10" } }));
  await syncEventToJira(db, "default", eventId);
  calls = [];

  await updateEvent(db, "default", eventId, { state: "done" });
  install((call) => {
    if (call.url.includes("/transitions") && call.method === "GET") {
      // 전이 이름은 영어인데 도착 상태가 "완료" 인 워크플로.
      return { status: 200, body: { transitions: [{ id: "31", name: "Finish Work", to: { name: "Done" } }] } };
    }
    return { status: 204 };
  });

  await syncEventToJira(db, "default", eventId, { stateChanged: true });
  assert.deepEqual(callsTo("/transitions", "POST")[0]?.body, { transition: { id: "31" } });
});

test("맞는 전이가 없으면 아무것도 하지 않고 사유를 남긴다", async () => {
  install(() => ({ status: 201, body: { key: "ABC-10" } }));
  await syncEventToJira(db, "default", eventId);
  calls = [];

  await updateEvent(db, "default", eventId, { state: "canceled" });
  install((call) => {
    if (call.url.includes("/transitions") && call.method === "GET") {
      return { status: 200, body: { transitions: [{ id: "11", name: "진행 중", to: { name: "In Progress" } }] } };
    }
    return { status: 204 };
  });

  const result = await syncEventToJira(db, "default", eventId, { stateChanged: true });
  assert.equal(callsTo("/transitions", "POST").length, 0, "추측해서 엉뚱한 상태로 밀면 안 된다");
  assert.match(result.message, /전이가 없습니다/);
  assert.match(result.message, /가능한 전이/, "무엇이 가능했는지 알려 줘야 한다");
});

test("상태가 안 바뀐 저장은 전이를 시도하지 않는다", async () => {
  install(() => ({ status: 201, body: { key: "ABC-10" } }));
  await syncEventToJira(db, "default", eventId);
  calls = [];

  install(() => ({ status: 204 }));
  await syncEventToJira(db, "default", eventId, { stateChanged: false });
  assert.equal(callsTo("/transitions").length, 0, "완료된 이슈에 같은 전이를 또 보내면 거부당한다");
});

test("취소는 완료 전이로 떨어지지 않는다", () => {
  // 취소를 완료로 적으면 보고서에서 '한 일' 로 집계된다.
  const canceled = transitionNames("canceled");
  assert.ok(canceled.includes("취소"));
  assert.ok(!canceled.includes("완료"));
  assert.ok(!canceled.includes("Done"));
});

test("전이 이름 후보를 환경변수로 늘릴 수 있다", () => {
  process.env.JIRA_TR_DONE = "마감, 종료 ";
  const names = transitionNames("done");
  assert.equal(names[0], "마감", "설정값이 기본값보다 앞에 온다");
  assert.ok(names.includes("종료"));
  assert.ok(names.includes("완료"), "기본값도 남아 있어야 한다");
});

/* ------------------------------------------------------------------ *
 * 삭제
 * ------------------------------------------------------------------ */

test("일정을 지우면 이슈도 지운다", async () => {
  install(() => ({ status: 201, body: { key: "ABC-10" } }));
  await syncEventToJira(db, "default", eventId);
  calls = [];

  install(() => ({ status: 204 }));
  const result = await removeEventFromJira(db, "default", eventId, "안용식(yongsik)");
  assert.equal(result.action, "deleted");
  assert.equal(result.leftBehind, false);

  const deleted = callsTo("/rest/api/3/issue/ABC-10", "DELETE")[0];
  assert.ok(deleted !== undefined);
  assert.ok(deleted.url.includes("deleteSubtasks=true"));
  assert.equal(deleted.body, null, "DELETE 에 본문을 실으면 게이트웨이가 거부하는 경우가 있다");
});

test("이미 없는 이슈(404)는 성공으로 본다", async () => {
  install(() => ({ status: 201, body: { key: "ABC-10" } }));
  await syncEventToJira(db, "default", eventId);
  calls = [];

  install(() => ({ status: 404, body: { errorMessages: ["Issue does not exist"] } }));
  const result = await removeEventFromJira(db, "default", eventId, "");
  assert.equal(result.action, "deleted", "이미 없는 것이 목표 상태다(멱등)");
  assert.equal(result.leftBehind, false);
});

test("지울 권한이 없으면 코멘트로 대신하고 '남아 있다' 고 알린다", async () => {
  install(() => ({ status: 201, body: { key: "ABC-10" } }));
  await syncEventToJira(db, "default", eventId);
  calls = [];

  install((call) => {
    if (call.method === "DELETE") return { status: 403, body: { errorMessages: ["no permission"] } };
    return { status: 201 };
  });

  const result = await removeEventFromJira(db, "default", eventId, "안용식(yongsik)");
  assert.equal(result.action, "commented");
  assert.equal(result.leftBehind, true, "화면이 '직접 처리해 주세요' 를 말할 근거다");

  const comment = callsTo("/rest/api/3/issue/ABC-10/comment", "POST")[0];
  assert.ok(comment !== undefined, "아무 표시도 없이 사라지면 Jira 쪽만 영원히 남는다");
  assert.ok(JSON.stringify(comment.body).includes("안용식"), "누가 지웠는지 남긴다");
});

test("삭제 응답을 못 받으면 성공으로 적지 않는다", async () => {
  install(() => ({ status: 201, body: { key: "ABC-10" } }));
  await syncEventToJira(db, "default", eventId);
  calls = [];

  install((call) => {
    if (call.method === "DELETE") {
      const error = new Error("timeout");
      error.name = "TimeoutError";
      return Promise.reject(error);
    }
    return { status: 204 };
  });

  const result = await removeEventFromJira(db, "default", eventId, "");
  assert.equal(result.action, "failed");
  assert.equal(result.leftBehind, true);
  assert.match(result.message, /확인하지 못했습니다/);
});

test("키가 없어도 '만들어졌는지 모름' 이면 찾아서 지운다", async () => {
  install(() => {
    const error = new Error("timeout");
    error.name = "TimeoutError";
    return Promise.reject(error);
  });
  await syncEventToJira(db, "default", eventId);
  calls = [];

  install((call) => {
    if (call.url.includes("/search/jql")) return { status: 200, body: { issues: [{ key: "ABC-77" }] } };
    return { status: 204 };
  });

  const result = await removeEventFromJira(db, "default", eventId, "");
  assert.equal(result.action, "deleted");
  assert.equal(
    callsTo("/rest/api/3/issue/ABC-77", "DELETE").length,
    1,
    "안 찾으면 그 이슈가 주인 없이 Jira 에 남는다",
  );
});

test("연결된 이슈가 없으면 아무것도 하지 않는다", async () => {
  install(() => ({ status: 204 }));
  const result = await removeEventFromJira(db, "default", eventId, "");
  assert.equal(result.action, "skipped");
  assert.equal(calls.length, 0);
});

/* ------------------------------------------------------------------ *
 * Jira 가 없거나 꺼져 있어도
 * ------------------------------------------------------------------ */

test("Jira 자동 등록이 꺼져 있으면 건드리지 않는다", async () => {
  delete process.env.JIRA_AUTO_CREATE;
  install(() => ({ status: 201, body: { key: "ABC-10" } }));

  const result = await syncEventToJira(db, "default", eventId);
  assert.equal(result.action, "skipped");
  assert.equal(calls.length, 0);

  const event = await getEvent(db, "default", eventId);
  assert.equal(event?.jiraState, "none", "'실패' 로 적으면 켰을 때 실패 이력이 있는 것처럼 보인다");
  assert.equal(event?.jiraTries, 0);
});

test("꺼져 있는데 이슈가 남아 있으면 '남아 있다' 고 알린다", async () => {
  install(() => ({ status: 201, body: { key: "ABC-10" } }));
  await syncEventToJira(db, "default", eventId);

  delete process.env.JIRA_AUTO_CREATE;
  calls = [];
  const result = await removeEventFromJira(db, "default", eventId, "");
  assert.equal(result.leftBehind, true);
  assert.match(result.message, /직접 처리/);
  assert.equal(calls.length, 0);
});

/* ------------------------------------------------------------------ *
 * 밀린 것 처리
 * ------------------------------------------------------------------ */

test("밀린 일정을 모아 올린다", async () => {
  const second = await createEvent(db, {
    teamId: "default",
    title: "두 번째",
    startDate: "2126-12-01",
  });

  let n = 0;
  install(() => {
    n += 1;
    return { status: 201, body: { key: `ABC-${n}` } };
  });

  const results = await syncPendingEvents(db, "default");
  assert.equal(results.length, 2);
  assert.ok((await getEvent(db, "default", eventId))?.jiraKey !== "");
  assert.ok((await getEvent(db, "default", second))?.jiraKey !== "");
});

test("지난 일정은 거슬러 올리지 않는다", async () => {
  // 기능을 켠 순간 몇 달치가 한꺼번에 쏟아지면 그건 사고다.
  await createEvent(db, {
    teamId: "default",
    title: "옛 일정",
    startDate: "2020-01-01",
    endDate: "2020-01-02",
  });

  install(() => ({ status: 201, body: { key: "ABC-1" } }));
  const results = await syncPendingEvents(db, "default");
  assert.equal(results.length, 1, "미래 일정 하나만 올라가야 한다");
});

test("이미 올라간 일정은 다시 올리지 않는다", async () => {
  install(() => ({ status: 201, body: { key: "ABC-10" } }));
  await syncEventToJira(db, "default", eventId);
  calls = [];

  const results = await syncPendingEvents(db, "default");
  assert.equal(results.length, 0);
  assert.equal(calls.length, 0);
});
