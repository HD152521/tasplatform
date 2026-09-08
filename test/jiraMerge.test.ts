import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeCenters, mergeKey, mergeRows, mergeSpan, workStatusLabel,
} from "../lib/jiraFormat.ts";
import type { Mergeable } from "../lib/jiraFormat.ts";

function row(
  corp: string, title: string, center: string,
  startDate: string, endDate: string | null = null,
): Mergeable {
  return { corp, title, center, startDate, endDate };
}

test("법인과 작업 내역이 같아야 같은 묶음이다", () => {
  assert.equal(mergeKey({ corp: "은행", title: "TAS 업그레이드" }),
    mergeKey({ corp: "은행", title: " TAS 업그레이드 " }));
  assert.notEqual(mergeKey({ corp: "은행", title: "TAS 업그레이드" }),
    mergeKey({ corp: "중앙회", title: "TAS 업그레이드" }));
});

test("전산센터를 중복 없이 순서대로 모은다", () => {
  assert.equal(mergeCenters(["운영", "DR"]), "운영,DR");
  assert.equal(mergeCenters(["운영", "운영", "DR"]), "운영,DR");
});

test("이미 합쳐진 값이나 슬래시 표기도 풀어서 합친다", () => {
  assert.equal(mergeCenters(["운영,DR", "검증"]), "운영,DR,검증");
  assert.equal(mergeCenters(["개발/운영", "DR"]), "개발,운영,DR");
});

// 사용자 규칙: a 가 1~3, b 가 2~4 면 1~4.
test("작업일은 포괄 범위로 넓힌다", () => {
  const merged = mergeSpan([
    { startDate: "2026-08-01", endDate: "2026-08-03" },
    { startDate: "2026-08-02", endDate: "2026-08-04" },
  ]);
  assert.deepEqual(merged, { startDate: "2026-08-01", endDate: "2026-08-04" });
});

// 안 끝난 작업이 섞이면 끝난 것처럼 보이면 안 된다.
test("하나라도 미종료면 끝을 비운다", () => {
  const merged = mergeSpan([
    { startDate: "2026-08-01", endDate: "2026-08-03" },
    { startDate: "2026-08-02", endDate: null },
  ]);
  assert.deepEqual(merged, { startDate: "2026-08-01", endDate: null });
});

test("같은 작업을 전산센터만 다르게 올린 것을 한 줄로 만든다", () => {
  const merged = mergeRows([
    row("은행", "TAS 업그레이드 사전 작업", "운영", "2026-08-04", "2026-08-10"),
    row("은행", "TAS 업그레이드 사전 작업", "DR", "2026-08-06", "2026-08-12"),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.center, "운영,DR");
  assert.equal(merged[0]?.startDate, "2026-08-04");
  assert.equal(merged[0]?.endDate, "2026-08-12");
  assert.equal(merged[0]?.merged, 2);
});

test("법인이 다르면 합치지 않는다", () => {
  const merged = mergeRows([
    row("은행", "silk-vtep 체크섬 해제", "개발", "2026-08-04", "2026-08-05"),
    row("중앙회", "silk-vtep 체크섬 해제", "개발", "2026-08-04", "2026-08-05"),
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((r) => r.corp), ["은행", "중앙회"]);
});

test("첫 등장 순서를 지킨다", () => {
  const merged = mergeRows([
    row("은행", "B 작업", "운영", "2026-08-10", "2026-08-10"),
    row("은행", "A 작업", "개발", "2026-08-01", "2026-08-01"),
    row("은행", "B 작업", "DR", "2026-08-11", "2026-08-11"),
  ]);
  assert.deepEqual(merged.map((r) => r.title), ["B 작업", "A 작업"]);
  assert.equal(merged[0]?.center, "운영,DR");
});

test("합칠 것이 없으면 그대로 둔다", () => {
  const merged = mergeRows([row("은행", "단독 작업", "개발", "2026-08-01", "2026-08-01")]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.merged, 1);
  assert.equal(merged[0]?.center, "개발");
});

// 보고서는 끝난 일을 "완료" 하나로만 적는다.
test("완료와 해결됨을 모두 완료로 적는다", () => {
  assert.equal(workStatusLabel("완료"), "완료");
  assert.equal(workStatusLabel("해결됨"), "완료");
  assert.equal(workStatusLabel("Done"), "완료");
  assert.equal(workStatusLabel("Resolved"), "완료");
});

test("진행 중은 진행중으로 적는다", () => {
  assert.equal(workStatusLabel("진행 중"), "진행중");
  assert.equal(workStatusLabel("In Progress"), "진행중");
});

// 모르는 상태를 바꾸면 사실이 왜곡된다.
test("모르는 상태는 그대로 둔다", () => {
  assert.equal(workStatusLabel("검토 대기"), "검토 대기");
});
