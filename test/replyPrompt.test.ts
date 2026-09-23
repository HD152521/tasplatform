import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REPLY_TIDY_PROMPT,
  REPLY_TRANSLATE_PROMPT,
  buildReplyUser,
  cleanReply,
  replyPromptFor,
} from "../lib/replyPrompt.ts";
import { DRAFT_SYSTEM_PROMPT } from "../lib/srDraftPrompt.ts";

const NEWLINE = String.fromCharCode(10);
const lines = (...parts: string[]): string => parts.join(NEWLINE);

// 답변 120건 실측: 인사말 86% / 맺음말 38% / 번호 2% / 불릿 1% / 중앙값 410자.
// 새 SR 본문과 달리 목록을 쓰지 않는다.
test("답변은 짧은 줄글이고 목록을 쓰지 않는다", () => {
  assert.match(REPLY_TRANSLATE_PROMPT, /짧은 영어 문단/);
  assert.match(REPLY_TRANSLATE_PROMPT, /번호 목록·불릿도 쓰지 않습니다/);
  assert.ok(REPLY_TRANSLATE_PROMPT.includes("Hello,"));
  assert.ok(REPLY_TRANSLATE_PROMPT.includes("Thanks,"));
});

test("새 SR 틀과 섞이지 않는다", () => {
  // 새 SR 은 Questions 묶음을 쓰지만 답변은 안 쓴다.
  assert.ok(DRAFT_SYSTEM_PROMPT.includes("Questions"));
  assert.ok(!REPLY_TRANSLATE_PROMPT.includes("Questions"));
});

test("다듬기는 언어를 바꾸지 말라고 못박는다", () => {
  assert.match(REPLY_TIDY_PROMPT, /언어를 바꾸지 않습니다/);
  assert.match(REPLY_TIDY_PROMPT, /내용을 바꾸지 않습니다/);
});

test("지어내지 말라고 못박는다", () => {
  for (const p of [REPLY_TRANSLATE_PROMPT, REPLY_TIDY_PROMPT]) {
    assert.match(p, /지어내지 않습니다/);
    assert.match(p, /원문 그대로/);
  }
});

test("mode 에 따라 다른 프롬프트를 고른다", () => {
  assert.equal(replyPromptFor("tidy"), REPLY_TIDY_PROMPT);
  assert.equal(replyPromptFor("translate"), REPLY_TRANSLATE_PROMPT);
});

/* ------------------------------------------------------------------ *
 * 사용자 메시지
 * ------------------------------------------------------------------ */

test("상대의 마지막 글을 참고로 함께 준다", () => {
  const user = buildReplyUser("확인해서 회신드리겠습니다", "Could you share the logs?");
  assert.match(user, /Broadcom 이 보낸 마지막 글/);
  assert.match(user, /Could you share the logs\?/);
  // 그 글을 번역해 버리면 안 된다.
  assert.match(user, /이 글을 번역하지 마세요/);
});

test("상대 글이 없으면 그 덩어리를 빼고 준다", () => {
  const user = buildReplyUser("내용만 있습니다");
  assert.ok(!user.includes("Broadcom 이 보낸 마지막 글"));
  assert.match(user, /내용만 있습니다/);
});

test("상대 글이 길면 잘라 토큰을 아낀다", () => {
  const user = buildReplyUser("답변", "x".repeat(500), "translate", 100);
  assert.ok(user.includes("x".repeat(100)));
  assert.ok(!user.includes("x".repeat(101)));
});

test("다듬기일 때는 본문 라벨이 달라진다", () => {
  assert.match(buildReplyUser("Some text", "", "tidy"), /언어를 바꾸지 말고 다듬기만/);
  assert.ok(!buildReplyUser("한국어", "", "translate").includes("언어를 바꾸지 말고"));
});

/* ------------------------------------------------------------------ *
 * 응답 정리
 * ------------------------------------------------------------------ */

test("코드펜스와 머리말을 걷어낸다", () => {
  assert.equal(cleanReply(lines("```", "Hello,", "```")), "Hello,");
  assert.equal(cleanReply("번역: Hello,"), "Hello,");
  assert.equal(cleanReply(lines("Reply:", "Hello,")), "Hello,");
});

test("본문 안의 코드블록은 건드리지 않는다", () => {
  const text = lines("Please run:", "```", "cf logs app", "```", "Thanks,");
  assert.equal(cleanReply(text), text);
});
