import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TARGET_CORPS,
  TARGET_ENVS,
  TARGET_PLACEHOLDER,
  buildTargetLabel,
} from "../lib/summaryTarget.ts";
import { buildMetaTable } from "../lib/summaryPrompt.ts";

test("법인 하나와 환경 하나", () => {
  assert.equal(buildTargetLabel(["bank"], ["운영"]), "[은]운영");
  assert.equal(buildTargetLabel(["central"], ["개발"]), "[중]개발");
});

test("둘 다 고르면 대괄호 안에서 슬래시로 잇는다", () => {
  assert.equal(buildTargetLabel(["bank", "central"], ["개발"]), "[은/중]개발");
});

test("환경을 여럿 고르면 쉼표로 잇는다", () => {
  assert.equal(buildTargetLabel(["bank", "central"], ["개발", "운영"]), "[은/중]개발,운영");
});

// 같은 조합이면 늘 같은 문자열이 나와야 문서끼리 비교가 된다.
test("고른 순서가 달라도 결과는 같다", () => {
  assert.equal(
    buildTargetLabel(["central", "bank"], ["운영", "개발"]),
    buildTargetLabel(["bank", "central"], ["개발", "운영"]),
  );
});

test("DR 과 AWS 도 고를 수 있다", () => {
  assert.equal(buildTargetLabel(["bank"], ["DR"]), "[은]DR");
  assert.equal(buildTargetLabel(["bank"], ["운영", "AWS"]), "[은]운영,AWS");
});

test("한쪽만 골라도 만들어진다", () => {
  assert.equal(buildTargetLabel(["bank"], []), "[은]");
  assert.equal(buildTargetLabel([], ["운영"]), "운영");
});

// 안 고르면 빈 문자열이고, 표에는 "(입력 필요)" 가 남는다.
test("아무것도 안 고르면 빈 문자열", () => {
  assert.equal(buildTargetLabel([], []), "");
});

test("모르는 값은 무시한다", () => {
  assert.equal(buildTargetLabel(["bank", "없는법인"], ["운영", "없는환경"]), "[은]운영");
});

test("양식이 정한 목록 그대로다", () => {
  assert.deepEqual(TARGET_CORPS.map((c) => c.label), ["은행", "중앙회"]);
  assert.deepEqual([...TARGET_ENVS], ["개발", "운영", "DR", "AWS"]);
});

/* ------------------------------------------------------------------ *
 * 표에 실리는 모양
 * ------------------------------------------------------------------ */

const TABLE_INPUT = {
  openedRaw: "2026-08-11",
  closedRaw: "2026-08-12",
  status: "Closed",
  priority: "3",
  meta: { type: "문의" },
};

test("고른 값이 표의 대상 환경 칸에 그대로 들어간다", () => {
  const table = buildMetaTable({
    ...TABLE_INPUT,
    target: buildTargetLabel(["bank", "central"], ["개발", "운영"]),
  });
  assert.ok(table.includes("| 대상 환경 | [은/중]개발,운영 |"), table);
});

test("안 고르면 입력 필요로 남는다", () => {
  const table = buildMetaTable({ ...TABLE_INPUT, target: buildTargetLabel([], []) });
  assert.ok(table.includes(`| 대상 환경 | ${TARGET_PLACEHOLDER} |`), table);
});
