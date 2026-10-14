/**
 * SR 초안 복구 규칙.
 *
 * 핵심은 **보관해 둔 값이 어떻든 작성 화면이 열려야 한다**는 것이다. 저장해 둔 값은
 * 지난 배포의 모양일 수 있고, 거기에 맞춰 화면 상태를 넣다가 깨지면 글을 아예 못 쓴다.
 * 초안 보존은 편의지, 글쓰기를 막아도 되는 값이 아니다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_SR_DRAFT, hasBody, parseSrDraft } from "../lib/srDraft.ts";
import { DEFAULT_SEVERITY } from "../lib/severity.ts";

test("저장한 모양을 그대로 돌려준다", () => {
  const draft = {
    serial: "SN-0001", release: "10.4.2", severity: "High - P2",
    subject: "제목", content: "본문",
  };
  assert.deepEqual(parseSrDraft(JSON.stringify(draft)), draft);
});

test("빈 문자열은 복구할 것이 없다", () => {
  assert.equal(parseSrDraft(""), null);
});

// 깨진 값으로 화면 상태를 채우면 작성 화면 자체가 열리지 않는다.
test("JSON 이 아니거나 모양이 아니면 던지지 않고 없는 것으로 둔다", () => {
  for (const bad of ["{", "null", '"그냥 글자"', "[]", "123"]) {
    assert.doesNotThrow(() => parseSrDraft(bad), `${bad} 에서 던졌다`);
    assert.equal(parseSrDraft(bad), null, `${bad} 는 null 이어야`);
  }
});

// 칸이 빠진 옛 모양도 받아야 한다 — 배포가 칸을 늘리면 그 전에 저장된 값이 그렇다.
test("빠진 칸은 빈 값으로 채운다", () => {
  const restored = parseSrDraft(JSON.stringify({ subject: "제목만 있던 때" }));
  assert.deepEqual(restored, {
    ...EMPTY_SR_DRAFT, subject: "제목만 있던 때",
  });
});

// 숫자·객체가 들어와도 문자열 칸으로 취급해야 한다(화면이 value 로 쓴다).
test("문자열이 아닌 값은 빈 값으로 둔다", () => {
  const restored = parseSrDraft(JSON.stringify({
    subject: 123, content: { a: 1 }, serial: null, release: [], severity: 7,
  }));
  assert.equal(restored, null, "알맹이가 없으니 복구할 것도 없다");
});

/*
 * 모르는 등급을 그대로 넣으면 선택칸이 빈 채로 떠 **등록이 막힌다.** 등급 이름이
 * 바뀌어도 글은 살아 있어야 한다.
 */
test("모르는 등급은 기본값으로 바꾼다", () => {
  const restored = parseSrDraft(JSON.stringify({
    severity: "긴급", subject: "제목", content: "본문",
  }));
  assert.equal(restored?.severity, DEFAULT_SEVERITY);
  assert.equal(restored?.subject, "제목");
});

/*
 * 알맹이(제목·본문)가 없으면 보관하지 않는다. 빈 칸만 담긴 값이 남으면 등록 직후에도
 * "복구할 초안이 있다" 고 오해한다.
 */
test("알맹이가 없으면 복구하지 않는다", () => {
  assert.equal(hasBody(EMPTY_SR_DRAFT), false);
  assert.equal(parseSrDraft(JSON.stringify(EMPTY_SR_DRAFT)), null);
  assert.equal(parseSrDraft(JSON.stringify({ ...EMPTY_SR_DRAFT, serial: "SN-1" })), null,
    "번호만 적어 둔 것은 글이 아니다");
  assert.equal(hasBody({ ...EMPTY_SR_DRAFT, subject: "   " }), false, "공백만 있는 것도 비었다");
  assert.equal(hasBody({ ...EMPTY_SR_DRAFT, content: "본문" }), true);
});
