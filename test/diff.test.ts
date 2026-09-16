import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { htmlToText, isOurThread, selectChangedCases, selectNewReplies } from "../lib/diff.ts";
import type { RequestThreadVo, SearchResultItem, UnifiedHistoryEntry } from "../lib/types.ts";

/** 실제 캡처된 응답을 픽스처로 쓴다. */
function realThreads(): RequestThreadVo[] {
  const raw = JSON.parse(readFileSync("captured/094_get_unified_history.json", "utf8")) as {
    response_preview: string;
  };
  const body = JSON.parse(raw.response_preview) as {
    data: { RequestDetails: UnifiedHistoryEntry[] };
  };
  return body.data.RequestDetails
    .map((e) => e.requestThreadVo)
    .filter((v): v is RequestThreadVo => Boolean(v));
}

const caseItem = (id: number, lastUpdated: string): SearchResultItem => ({
  requestId: id, requestIdFormatted: String(id), requestDesc: "제목",
  statusAliasName: "Open", priorityName: "P3", subCategoryName: "Ops",
  partyName: "고객사", partySiteNumber: "1", createdOn: "01-September-2026 00:00:00",
  lastUpdated,
});

test("최초 수집이면 전부 신규", () => {
  const changes = selectChangedCases([caseItem(1, "a"), caseItem(2, "b")], new Map());
  assert.equal(changes.length, 2);
  assert.ok(changes.every((c) => c.reason === "new"));
});

test("lastUpdated 가 같으면 변경 없음", () => {
  const known = new Map([[1, "a"]]);
  assert.equal(selectChangedCases([caseItem(1, "a")], known).length, 0);
});

test("lastUpdated 가 달라지면 변경으로 잡는다", () => {
  const known = new Map([[1, "a"]]);
  const changes = selectChangedCases([caseItem(1, "z")], known);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.reason, "updated");
});

test("실제 캡처된 스레드는 Broadcom 답변으로 판정된다", () => {
  const threads = realThreads();
  assert.ok(threads.length >= 2);
  for (const t of threads) {
    assert.ok(t.createdUserUnitName.toLowerCase().includes("broadcom"));
    assert.equal(isOurThread(t), false);
  }
});

test("creatorFlag 가 true면 우리 글", () => {
  assert.equal(isOurThread({ creatorFlag: true, createdUserUnitName: "우리팀" }), true);
});

test("작성자를 알 수 없으면 답변으로 간주한다 (놓치지 않기 위해)", () => {
  assert.equal(isOurThread({ creatorFlag: false, createdUserUnitName: "" }), false);
});

test("이미 아는 스레드는 새 답변이 아니다", () => {
  const threads = realThreads();
  const knownAll = new Set(threads.map((t) => t.requestThreadId));
  assert.equal(selectNewReplies(threads, knownAll).length, 0);
  assert.equal(selectNewReplies(threads, new Set()).length, threads.length);
});

test("우리 글만 추가되면 새 답변 0건", () => {
  const ours: RequestThreadVo = {
    ...realThreads()[0]!, requestThreadId: 999, creatorFlag: true,
    createdUserUnitName: "데이터솔루션",
  };
  assert.equal(selectNewReplies([ours], new Set()).length, 0);
});

test("htmlToText 가 태그와 엔티티를 정리한다", () => {
  assert.equal(htmlToText("<p>Hi&nbsp;team</p><p>Thanks</p>"), "Hi team\n\nThanks");
});

test("내부/외부 중복 답변은 알림에서 한 건으로 합친다", async () => {
  const { dedupeReplies } = await import("../lib/diff.ts");
  const base = realThreads()[0]!;
  const pair = [
    { ...base, requestThreadId: 1, resDate: 1788326048124, resDesc: "<p>Hi Team</p>" },
    // 8초 뒤 동일 본문 (HTML 길이만 다름) -> 같은 답변
    { ...base, requestThreadId: 2, resDate: 1788326056985, resDesc: "<p>Hi&nbsp;Team</p>" },
  ];
  assert.equal(dedupeReplies(pair).length, 1);
});

test("시간 간격이 크면 별개 답변으로 둔다", async () => {
  const { dedupeReplies } = await import("../lib/diff.ts");
  const base = realThreads()[0]!;
  const pair = [
    { ...base, requestThreadId: 1, resDate: 1788326048124, resDesc: "<p>확인 부탁드립니다</p>" },
    // 하루 뒤 같은 문구 -> 진짜 재촉 메시지이므로 살린다
    { ...base, requestThreadId: 2, resDate: 1788326048124 + 86_400_000, resDesc: "<p>확인 부탁드립니다</p>" },
  ];
  assert.equal(dedupeReplies(pair).length, 2);
});

test("다른 케이스의 같은 문구는 합치지 않는다", async () => {
  const { dedupeReplies } = await import("../lib/diff.ts");
  const base = realThreads()[0]!;
  const pair = [
    { ...base, requestThreadId: 1, requestId: 100, resDate: 1, resDesc: "<p>Hi Team</p>" },
    { ...base, requestThreadId: 2, requestId: 200, resDate: 2, resDesc: "<p>Hi Team</p>" },
  ];
  assert.equal(dedupeReplies(pair).length, 2);
});
