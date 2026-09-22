import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KOREAN_RATIO,
  TRANSLATE_SYSTEM_PROMPT,
  cleanTranslation,
  koreanRatio,
  needsTranslation,
} from "../lib/caseTranslate.ts";

const NEWLINE = String.fromCharCode(10);
const lines = (...parts: string[]): string => parts.join(NEWLINE);

test("그대로 옮기라고 못박는다", () => {
  assert.match(TRANSLATE_SYSTEM_PROMPT, /요약하거나 줄이거나/);
  assert.match(TRANSLATE_SYSTEM_PROMPT, /원문 그대로 둡니다/);
});

test("한글 비율을 잰다", () => {
  assert.equal(koreanRatio(""), 0);
  assert.equal(koreanRatio("   "), 0);
  assert.equal(koreanRatio("가나다"), 1);
  assert.equal(koreanRatio("abcd"), 0);
  // 공백은 세지 않는다.
  assert.equal(koreanRatio("가 a"), 0.5);
});

test("영문은 번역 대상이다", () => {
  assert.ok(needsTranslation("The Gorouter drops websocket connections after 30 seconds."));
});

// Broadcom 답변 2,605건 중 379건(15%)이 이미 한국어다(APAC 한국인 엔지니어).
// 다시 번역하면 돈만 쓰고 원문이 뭉개진다.
test("이미 한국어인 글은 건너뛴다", () => {
  assert.ok(!needsTranslation("안녕하세요. 확인 후 회신드리겠습니다."));
});

test("빈 글은 번역하지 않는다", () => {
  assert.ok(!needsTranslation(""));
  assert.ok(!needsTranslation("   "));
});

test("영어에 한글이 조금 섞인 글은 번역한다", () => {
  // 인사말만 한국어이고 본문이 영어인 경우 — 읽으려면 번역이 필요하다.
  const text = lines(
    "안녕하세요,",
    "The issue is caused by a known defect in the routing tier configuration.",
    "Please apply the workaround described in the attached document and let us know.",
  );
  assert.ok(koreanRatio(text) < KOREAN_RATIO, String(koreanRatio(text)));
  assert.ok(needsTranslation(text));
});

test("코드펜스와 머리말을 걷어낸다", () => {
  assert.equal(cleanTranslation(lines("```", "본문입니다.", "```")), "본문입니다.");
  assert.equal(cleanTranslation("번역: 본문입니다."), "본문입니다.");
  assert.equal(cleanTranslation(lines("Translation:", "본문입니다.")), "본문입니다.");
});

test("본문 안의 코드블록은 건드리지 않는다", () => {
  const text = lines("아래 명령을 실행하세요.", "```", "cf scale app -i 4", "```", "감사합니다.");
  assert.equal(cleanTranslation(text), text);
});
