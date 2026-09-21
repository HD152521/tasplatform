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
  getMonthlyWorkHandler,
  hasAnyCount,
  monthKeyOf,
  readCounts,
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
    fetchMonthlyWork: async () => ({ rows: [{ title: "작업" }], skipped: [], scanned: 1 }) as never,
    loadMonth: async () => null,
    saveMonth: async (month) => ({ month }) as never,
    resolvePrevious: async () => ({ values: {} as never, fromMonth: "2026-07" }),
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
