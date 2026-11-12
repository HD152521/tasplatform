/**
 * 간단히 올리기 결과를 작성 폼에 채울 값으로 읽기.
 *
 * 이 판정이 틀려도 **화면은 멀쩡해 보인다** — 칸은 다 채워져 있고 값만 틀렸다. 사람이
 * 올리기를 누르고 포털 응답에서야 드러난다. 그래서 순수 함수로 떼어 여기서 잠근다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuickFill, quickFillNotes, type QuickFill } from "../lib/quickFill.ts";

/** 서버가 제대로 돌려준 모양. */
const OK: Record<string, unknown> = {
  ok: true,
  subject: "[VMware vSphere ESXi] Disk remains in original AZ after VM migration",
  content: "Hello Support Team,\n\nWe migrated a virtual machine.\n\nThanks,",
  productId: 10,
  productName: "VMware vSphere ESXi",
  componentId: 20,
  componentName: "ESXi Host Management",
  releaseId: 300,
  releaseDesc: "8.0 U2",
  jiraTitle: "vSphere ESXi 디스크 AZ 잔류 현상",
  jiraBody: "배경: …\n질문: …",
  missing: ["VM 이름", "디스크 식별자"],
  reason: "디스크가 VM 에 남는 현상이라 ESXi Host Management 를 골랐다",
  fallback: false,
  warning: "",
};

const MEMO = "disk가 기존 az에 계속 남아있음";

function fillOf(over: Partial<QuickFill> = {}): QuickFill {
  const base = parseQuickFill(OK, MEMO, "Medium - P3");
  assert.ok(base !== null);
  return { ...base, ...over };
}

/* ------------------------------------------------------------------ *
 * 읽기
 * ------------------------------------------------------------------ */

test("제대로 온 응답을 그대로 읽는다", () => {
  const got = parseQuickFill(OK, MEMO, "Medium - P3");
  assert.ok(got !== null);
  assert.equal(got.productId, 10);
  assert.equal(got.componentId, 20);
  assert.equal(got.releaseId, 300);
  assert.equal(got.titleKo, "vSphere ESXi 디스크 AZ 잔류 현상");
  assert.deepEqual([...got.missing], ["VM 이름", "디스크 식별자"]);
  // 적은 메모와 고른 심각도는 응답이 아니라 화면이 들고 있던 값이다.
  assert.equal(got.memo, MEMO);
  assert.equal(got.severity, "Medium - P3");
});

/*
 * 없으면 올릴 수 없는 값이다. `?? 0` 으로 메우면 productId 0 으로 등록을 시도하고,
 * 그 실패 원인은 포털 응답까지 가서야 드러난다.
 */
test("없으면 올릴 수 없는 값이 빠지면 거부한다", () => {
  for (const key of ["subject", "content", "productId", "componentId"]) {
    const broken = { ...OK, [key]: key.endsWith("Id") ? 0 : "" };
    assert.equal(parseQuickFill(broken, MEMO, "Medium - P3"), null, key);
  }
});

test("음수나 소수 id 는 없는 것으로 본다", () => {
  assert.equal(parseQuickFill({ ...OK, productId: -1 }, MEMO, "P3"), null);
  assert.equal(parseQuickFill({ ...OK, componentId: 1.5 }, MEMO, "P3"), null);
});

// 버전은 **없어도 올릴 수 있다**(화면에서 고른다). 그래서 거부 조건에 넣지 않는다.
test("버전이 없어도 거부하지 않는다", () => {
  const got = parseQuickFill({ ...OK, releaseId: 0, releaseDesc: "" }, MEMO, "P3");
  assert.ok(got !== null);
  assert.equal(got.releaseId, 0);
});

test("모르는 fallback 값은 폴백으로 본다", () => {
  // 조용히 "AI 가 골랐다" 고 보여 주는 쪽보다 경고를 띄우고 마는 쪽이 낫다.
  assert.equal(fillOf().fallback, false);
  const unknown = parseQuickFill({ ...OK, fallback: undefined }, MEMO, "P3");
  assert.equal(unknown?.fallback, true);
});

test("missing 이 배열이 아니면 빈 목록으로 둔다", () => {
  const got = parseQuickFill({ ...OK, missing: "VM 이름" }, MEMO, "P3");
  assert.deepEqual([...(got?.missing ?? ["X"])], []);
});

/* ------------------------------------------------------------------ *
 * 채운 뒤 사람이 봐야 할 것
 * ------------------------------------------------------------------ */

/** 걸릴 것이 하나도 없는 값. 기본 OK 에는 못 채운 자리가 들어 있다. */
const CLEAN: Partial<QuickFill> = { missing: [] };

test("다 괜찮으면 아무 말도 하지 않는다", () => {
  assert.deepEqual(quickFillNotes(fillOf(CLEAN), true), []);
});

/*
 * 고른 조합이 화면 목록에 없으면 Select 는 **다른 값**을 보여 준다(첫 항목으로
 * 떨어진다). 사람은 AI 가 고른 값이라고 믿고 올린다 — 엉뚱한 팀으로 간다.
 */
test("고른 조합이 목록에 없으면 직접 고르라고 말한다", () => {
  const notes = quickFillNotes(fillOf(CLEAN), false);
  assert.equal(notes.length, 1);
  assert.match(notes[0] ?? "", /목록에 없습니다/);
  assert.match(notes[0] ?? "", /ESXi Host Management/);
});

test("기본값으로 떨어진 것을 말한다", () => {
  const notes = quickFillNotes(fillOf({ ...CLEAN, fallback: true }), true);
  assert.match(notes[0] ?? "", /가장 많이 쓴 조합/);
});

// 둘 다일 때 "목록에 없다" 가 먼저다 — 그쪽이 사람이 할 일을 더 분명히 말한다.
test("목록에 없는 것과 폴백을 같이 말하지 않는다", () => {
  const notes = quickFillNotes(fillOf({ ...CLEAN, fallback: true }), false);
  assert.equal(notes.filter((n) => n.includes("Product")).length, 1);
  assert.match(notes[0] ?? "", /목록에 없습니다/);
});

test("버전을 못 집었으면 고르라고 말한다", () => {
  const notes = quickFillNotes(fillOf({ ...CLEAN, releaseId: 0, releaseDesc: "" }), true);
  assert.match(notes.join(" "), /Prod Release 를 골라야/);
});

test("못 채운 자리를 말한다", () => {
  const withGaps = quickFillNotes(fillOf({ missing: ["VM 이름"] }), true);
  assert.match(withGaps.join(" "), /VM 이름/);
  assert.match(withGaps.join(" "), /되묻습니다/);
});

// 본문에 한국어가 남은 경우. 그 글은 그대로 벤더에게 나간다.
test("본문 경고를 그대로 옮긴다", () => {
  const notes = quickFillNotes(fillOf({ ...CLEAN, warning: "본문에 한국어가 남아 있습니다." }), true);
  assert.ok(notes.includes("본문에 한국어가 남아 있습니다."));
});
