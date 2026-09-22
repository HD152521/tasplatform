/**
 * 정기점검 보고서 MCP 도구.
 *
 * mcp/serverDeps.ts 를 불러오지 않는다 — 거기서 값으로 끌어오는 lib/jira.ts 등이
 * server-only 라 평범한 node --test 에서 즉시 throw 한다. 가짜 deps 로 핸들러만 시험한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REQUIRED_COUNTS,
  buildReportHandler,
  downloadUrl,
  getInstanceCountsHandler,
  getMonthlyCasesHandler,
  getMonthlyWorkHandler,
  hasAnyCount,
  monthKeyOf,
  parseKeyList,
  readCounts,
  readKind,
  resolveSelection,
  setReportPicksHandler,
  type ReportDeps,
} from "../mcp/reportTools.ts";

/** 아홉 칸을 다 채운 인자. */
const NINE = {
  bankDev: 1, bankProd: 2, bankDr: 3,
  centralDev: 4, centralProd: 5, centralDr: 6,
  sharedDev: 7, sharedProd: 8, sharedDr: 9,
};

function deps(over: Partial<ReportDeps> = {}): ReportDeps {
  return {
    atlassianConfig: () => ({
      base: "https://example.atlassian.net",
      email: "a@b.c",
      token: "t",
      jiraProject: "PA",
      confluenceSpace: "S",
      confluenceParentId: "1",
    }),
    fetchMonthlyWork: async () => ({
      rows: [{ key: "PA-1", title: "작업" }, { key: "PA-2", title: "작업2" }],
      skipped: [], scanned: 2,
    }) as never,
    loadMonth: async () => null,
    saveMonth: async (month) => ({ month }) as never,
    resolvePrevious: async () => ({ values: {} as never, fromMonth: "2026-07" }),
    listCasesInMonth: async () => [
      { request_id: 990001, request_id_formatted: "SR-990001", subject: "증상" },
      { request_id: 990002, request_id_formatted: "SR-990002", subject: "증상2" },
    ] as never,
    // 기본값은 "SR 은 골라 뒀고 Jira 는 안 골랐다" — 실제로 가장 흔한 상태다.
    loadPicks: async (_month, kind) => (kind === "sr" ? ["990001"] : []),
    savePicks: async () => {},
    appUrl: "https://sr.example.com",
    ...over,
  };
}

/* ------------------------------------------------------------------ *
 * 연·월
 * ------------------------------------------------------------------ */

test("연과 월을 붙여 YYYY-MM 으로 만든다", () => {
  assert.deepEqual(monthKeyOf({ year: 2026, month: 8 }), { key: "2026-08" });
  assert.deepEqual(monthKeyOf({ year: 2026, month: 12 }), { key: "2026-12" });
});

test("문자열로 와도 숫자로 읽는다", () => {
  assert.deepEqual(monthKeyOf({ year: "2026", month: "8" }), { key: "2026-08" });
});

// 챗봇이 "26" 같은 두 자리를 넣으면 0026년을 조회하고 빈 결과를 정상처럼 돌려준다.
test("두 자리 연도는 거부한다", () => {
  const got = monthKeyOf({ year: 26, month: 8 });
  assert.ok("message" in got);
  assert.match(got.message, /year/);
});

test("1~12 를 벗어난 월은 거부한다", () => {
  for (const month of [0, 13, 1.5, "팔월"]) {
    const got = monthKeyOf({ year: 2026, month });
    assert.ok("message" in got, String(month));
  }
});

/* ------------------------------------------------------------------ *
 * 수치
 * ------------------------------------------------------------------ */

test("아홉 칸이 다 있으면 InstanceInput 을 만든다", () => {
  const got = readCounts(NINE);
  assert.ok("input" in got);
  assert.equal(got.input.central.prod, 5);
  assert.equal(got.input.shared.dr, 9);
});

// 빠진 값을 0 으로 채우면 표가 조용히 틀어진다. 무엇이 빠졌는지 돌려줘야 챗봇이 물어본다.
test("빠진 칸은 이름으로 알려 준다", () => {
  const { bankProd, bankDr, ...rest } = NINE;
  const got = readCounts(rest);
  assert.ok("missing" in got);
  assert.deepEqual(got.missing, ["bankProd", "bankDr"]);
});

test("음수나 숫자가 아닌 값은 빠진 것으로 본다", () => {
  const got = readCounts({ ...NINE, bankDev: -1, centralProd: "다섯" });
  assert.ok("missing" in got);
  assert.deepEqual(got.missing, ["bankDev", "centralProd"]);
});

test("하나라도 주면 수치를 준 것으로 본다", () => {
  assert.ok(hasAnyCount({ bankDev: 1 }));
  assert.ok(!hasAnyCount({}));
});

test("다운로드 주소는 끝 슬래시를 겹치지 않는다", () => {
  assert.equal(
    downloadUrl("https://sr.example.com/", "2026-08"),
    "https://sr.example.com/api/report/build?month=2026-08",
  );
});

/* ------------------------------------------------------------------ *
 * get_monthly_work
 * ------------------------------------------------------------------ */

test("작업 내역을 조회한다", async () => {
  let asked = "";
  const got = await getMonthlyWorkHandler(
    deps({ fetchMonthlyWork: async (_c, month) => { asked = month; return { rows: [], skipped: [], scanned: 0 } as never; } }),
    { year: 2026, month: 8 },
  );
  assert.ok(got.ok);
  assert.equal(asked, "2026-08");
  assert.equal(got.month, "2026-08");
});

test("연·월이 틀리면 조회하지 않는다", async () => {
  let called = false;
  const got = await getMonthlyWorkHandler(
    deps({ fetchMonthlyWork: async () => { called = true; return {} as never; } }),
    { year: 2026, month: 13 },
  );
  assert.ok(!got.ok);
  assert.ok(!called, "잘못된 월로 Jira 를 부르면 안 된다");
});

test("Atlassian 설정이 없으면 이유를 돌려준다", async () => {
  const got = await getMonthlyWorkHandler(deps({ atlassianConfig: () => null }), { year: 2026, month: 8 });
  assert.ok(!got.ok);
  assert.match(got.message, /Atlassian/);
});

/* ------------------------------------------------------------------ *
 * get_instance_counts
 * ------------------------------------------------------------------ */

test("저장된 수치가 없으면 채워야 할 아홉 칸을 알려 준다", async () => {
  const got = await getInstanceCountsHandler(deps(), { year: 2026, month: 8 });
  assert.ok(got.ok);
  assert.equal(got.saved, null);
  assert.deepEqual([...got.required], [...REQUIRED_COUNTS]);
});

/* ------------------------------------------------------------------ *
 * build_report
 * ------------------------------------------------------------------ */

test("수치를 주면 저장하고 주소를 돌려준다", async () => {
  let savedMonth = "";
  const got = await buildReportHandler(
    deps({ saveMonth: async (month) => { savedMonth = month; return { month } as never; } }),
    { year: 2026, month: 8, ...NINE },
  );
  assert.ok(got.ok);
  assert.equal(savedMonth, "2026-08");
  assert.equal(got.url, "https://sr.example.com/api/report/build?month=2026-08");
  assert.equal(got.previousFrom, "2026-07");
});

// 저장된 게 있으면 다시 물어보지 않는다.
test("수치를 안 줘도 저장된 것이 있으면 주소를 돌려준다", async () => {
  let saved = false;
  const got = await buildReportHandler(
    deps({
      loadMonth: async (month) => ({ month }) as never,
      saveMonth: async (month) => { saved = true; return { month } as never; },
    }),
    { year: 2026, month: 8 },
  );
  assert.ok(got.ok);
  assert.ok(!saved, "이미 저장된 달을 다시 저장하면 안 된다");
});

// 챗봇이 이 메시지를 보고 사용자에게 아홉 칸을 물어본다.
test("수치도 없고 저장된 것도 없으면 무엇을 물어야 할지 알려 준다", async () => {
  const got = await buildReportHandler(deps(), { year: 2026, month: 8 });
  assert.ok(!got.ok);
  for (const field of REQUIRED_COUNTS) assert.ok(got.message.includes(field), field);
});

test("수치를 일부만 주면 빠진 칸을 짚어 준다", async () => {
  const got = await buildReportHandler(deps(), { year: 2026, month: 8, bankDev: 1, bankProd: 2, bankDr: 3 });
  assert.ok(!got.ok);
  assert.match(got.message, /centralDev/);
});

// 빌드는 링크를 열 때 일어난다. 도구 안에서 하면 60초 타임아웃에 걸린다.
test("도구는 보고서를 만들지 않고 주소만 돌려준다", async () => {
  const got = await buildReportHandler(deps(), { year: 2026, month: 8, ...NINE });
  assert.ok(got.ok);
  assert.match(got.note, /주소를 열면/);
});

/* ------------------------------------------------------------------ *
 * 항목 고르기
 * ------------------------------------------------------------------ */

test("쉼표로 이은 key 목록을 쪼갠다", () => {
  assert.deepEqual(parseKeyList("PA-101, PA-104"), ["PA-101", "PA-104"]);
  // 줄바꿈으로 붙여 보내는 경우도 있다. 중복은 순서를 지키며 걷어낸다.
  assert.deepEqual(parseKeyList("PA-1\nPA-2\nPA-1"), ["PA-1", "PA-2"]);
  assert.deepEqual(parseKeyList(""), []);
  assert.deepEqual(parseKeyList(undefined), []);
});

test("kind 는 sr 과 jira 만 받는다", () => {
  assert.equal(readKind("sr"), "sr");
  assert.equal(readKind("jira"), "jira");
  assert.equal(readKind("SR"), null);
  assert.equal(readKind(undefined), null);
});

test("남길 것을 주면 그대로 고른다", () => {
  const got = resolveSelection(["A", "B", "C"], { keys: "A, C" });
  assert.ok("keys" in got);
  assert.deepEqual(got.keys, ["A", "C"]);
});

test("뺄 것을 주면 나머지를 고른다", () => {
  const got = resolveSelection(["A", "B", "C"], { excludeKeys: "B" });
  assert.ok("keys" in got);
  assert.deepEqual(got.keys, ["A", "C"]);
});

// 모델이 없는 키를 지어내도 조용히 저장하면 빌드에서 그 줄이 사라지는 것으로만 드러난다.
test("목록에 없는 key 는 저장하지 않고 돌려준다", () => {
  const got = resolveSelection(["A", "B"], { keys: "A, ZZ" });
  assert.ok("keys" in got);
  assert.deepEqual(got.keys, ["A"]);
  assert.deepEqual(got.unknownKeys, ["ZZ"]);
});

test("둘 다 주거나 둘 다 안 주면 거부한다", () => {
  assert.ok("message" in resolveSelection(["A"], {}));
  assert.ok("message" in resolveSelection(["A"], { keys: "A", excludeKeys: "A" }));
});

// 빈 선택은 "하나도 안 넣는다" 가 아니라 "선택 없음" 으로 읽힌다 — Jira 는 정반대로
// 전부 들어가고 SR 은 빌드가 실패한다. 어느 쪽도 사용자가 기대한 결과가 아니다.
test("전부 빼는 것은 거부한다", () => {
  const got = resolveSelection(["A", "B"], { excludeKeys: "A, B" });
  assert.ok("message" in got);
  assert.match(got.message, /최소 한 건/);
});

test("아는 key 가 하나도 없으면 거부한다", () => {
  const got = resolveSelection(["A"], { keys: "ZZ" });
  assert.ok("message" in got);
  assert.match(got.message, /하나도 없습니다/);
});

/* ------------------------------------------------------------------ *
 * get_monthly_cases · set_report_picks
 * ------------------------------------------------------------------ */

test("SR 후보에 번호와 key 를 함께 싣는다", async () => {
  const got = await getMonthlyCasesHandler(deps(), { year: 2026, month: 8 });
  assert.ok(got.ok);
  assert.deepEqual(got.cases[0], {
    no: 1, key: "990001", label: "SR-990001", openedOn: undefined,
    subject: "증상", status: undefined, product: undefined, party: undefined,
  });
  assert.deepEqual(got.picked, ["990001"]);
});

test("작업 목록에도 번호와 현재 선택을 싣는다", async () => {
  const got = await getMonthlyWorkHandler(deps(), { year: 2026, month: 8 });
  assert.ok(got.ok);
  assert.deepEqual(got.rows[0], { no: 1, key: "PA-1", title: "작업" });
  // 선택이 없으면 전부 들어간다 — 화면의 기본값과 같다.
  assert.deepEqual(got.picked, []);
  assert.match(got.pickedNote, /전부 들어갑니다/);
});

test("고른 것을 화면과 같은 곳에 저장한다", async () => {
  let wrote: { month: string; kind: string; refs: readonly string[] } | null = null;
  const got = await setReportPicksHandler(
    deps({ savePicks: async (month, kind, refs) => { wrote = { month, kind, refs }; } }),
    { year: 2026, month: 8, kind: "jira", excludeKeys: "PA-2" },
  );
  assert.ok(got.ok);
  assert.deepEqual(wrote, { month: "2026-08", kind: "jira", refs: ["PA-1"] });
  assert.equal(got.saved, 1);
  assert.equal(got.available, 2);
});

test("SR 도 같은 도구로 고른다", async () => {
  let refs: readonly string[] = [];
  const got = await setReportPicksHandler(
    deps({ savePicks: async (_m, _k, r) => { refs = r; } }),
    { year: 2026, month: 8, kind: "sr", keys: "990002" },
  );
  assert.ok(got.ok);
  assert.deepEqual(refs, ["990002"]);
});

test("kind 가 없거나 이상하면 거부한다", async () => {
  const got = await setReportPicksHandler(deps(), { year: 2026, month: 8, keys: "PA-1" });
  assert.ok(!got.ok);
  assert.match(got.message, /kind/);
});

test("저장 실패로 이어질 선택은 쓰지 않는다", async () => {
  let wrote = false;
  const got = await setReportPicksHandler(
    deps({ savePicks: async () => { wrote = true; } }),
    { year: 2026, month: 8, kind: "jira", excludeKeys: "PA-1, PA-2" },
  );
  assert.ok(!got.ok);
  assert.ok(!wrote, "전부 빼는 선택을 저장하면 안 된다");
});

/* ------------------------------------------------------------------ *
 * SR 미선택 방어
 * ------------------------------------------------------------------ */

// 여기서 막지 않으면 주소를 받아 열었을 때에야 502 로 드러난다 —
// 챗봇은 이미 "다 됐습니다" 라고 말한 뒤다.
test("SR 을 안 골랐으면 주소를 주지 않고 무엇을 해야 할지 알려 준다", async () => {
  const got = await buildReportHandler(
    deps({ loadPicks: async () => [] }),
    { year: 2026, month: 8, ...NINE },
  );
  assert.ok(!got.ok);
  assert.match(got.message, /set_report_picks/);
  assert.match(got.message, /인스턴스 수치는 저장/);
});

test("선택 건수를 함께 돌려준다", async () => {
  const got = await buildReportHandler(
    deps({ loadPicks: async (_m, kind) => (kind === "sr" ? ["990001", "990002"] : ["PA-1"]) }),
    { year: 2026, month: 8, ...NINE },
  );
  assert.ok(got.ok);
  assert.equal(got.srPicked, 2);
  assert.equal(got.workPicked, 1);
});
