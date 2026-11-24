/**
 * 메모 글 → 노션 블록.
 *
 * 이 변환이 틀리면 **"정리해서 올린다" 는 기능이 거기서 풀린다** — 글머리 기호가 `-`
 * 글자로 남고 줄바꿈이 뭉친다. 그리고 노션의 두 상한(한 요청 100블록, rich text
 * 2000자)을 넘기면 요청 **전체**가 거절당한다. 그 둘을 여기서 잠근다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NOTION_BLOCK_LIMIT,
  NOTION_TEXT_LIMIT,
  notionBlockBatches,
  notionBlocksOf,
  notionFooter,
  type NotionBlock,
} from "../lib/notionBlocks.ts";
import type { MentionablePerson } from "../lib/mentionSpans.ts";

const PEOPLE: readonly MentionablePerson[] = [
  { displayName: "안용식", loginId: "yongsik", jiraAccountId: "acct-1" },
];

/** 블록의 rich_text 를 글로 되돌린다. */
function textOf(block: NotionBlock): string {
  const rich =
    block.paragraph?.rich_text
    ?? block.bulleted_list_item?.rich_text
    ?? block.numbered_list_item?.rich_text
    ?? [];
  return rich.map((r) => r.text.content).join("");
}

test("빈 글은 블록이 없다", () => {
  assert.deepEqual(notionBlocksOf(""), []);
  assert.deepEqual(notionBlocksOf("  \n\n "), []);
});

test("글머리 기호는 노션 목록 블록이 된다 — `-` 글자로 남으면 안 된다", () => {
  const blocks = notionBlocksOf("- 로그 받기\n- 결과 공유");
  assert.deepEqual(blocks.map((b) => b.type), ["bulleted_list_item", "bulleted_list_item"]);
  assert.deepEqual(blocks.map(textOf), ["로그 받기", "결과 공유"]);
});

test("번호 목록은 노션 번호 목록이 된다 — 번호는 노션이 센다", () => {
  const blocks = notionBlocksOf("1. 먼저\n2) 그다음");
  assert.deepEqual(blocks.map((b) => b.type), ["numbered_list_item", "numbered_list_item"]);
  // 적힌 번호를 글에 남기면 노션 화면에 "1. 1. 먼저" 가 된다.
  assert.deepEqual(blocks.map(textOf), ["먼저", "그다음"]);
});

test("문단 안의 줄바꿈은 한 블록에 남는다 — 줄마다 블록이면 글이 흩어진다", () => {
  const blocks = notionBlocksOf("첫 줄\n둘째 줄");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, "paragraph");
  assert.equal(textOf(blocks[0] as NotionBlock), "첫 줄\n둘째 줄");
});

test("빈 줄은 문단을 나눈다", () => {
  const blocks = notionBlocksOf("앞 문단\n\n뒤 문단");
  assert.deepEqual(blocks.map(textOf), ["앞 문단", "뒤 문단"]);
});

test("머리말 + 목록이 섞인 글이 모양을 지킨다", () => {
  const blocks = notionBlocksOf("점검 결과\n- A 정상\n- B 지연\n재점검 예정");
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["paragraph", "bulleted_list_item", "bulleted_list_item", "paragraph"],
  );
});

test("@이름 은 굵은 글자로 올라간다 — 노션 계정 id 를 모르므로 멘션은 만들지 않는다", () => {
  const blocks = notionBlocksOf("@yongsik 확인 부탁", PEOPLE);
  const rich = blocks[0]?.paragraph?.rich_text ?? [];
  assert.equal(rich[0]?.text.content, "@안용식", "아이디가 아니라 사람 이름으로 펴야 한다");
  assert.deepEqual(rich[0]?.annotations, { bold: true });
  // 추측한 계정 id 를 넣으면 요청이 거절당하거나 엉뚱한 사람이 불린다.
  assert.ok(!JSON.stringify(blocks).includes("mention"), JSON.stringify(blocks));
});

test("2000자를 넘는 글은 자르지 않고 쪼갠다", () => {
  const long = "가".repeat(NOTION_TEXT_LIMIT + 500);
  const rich = notionBlocksOf(long)[0]?.paragraph?.rich_text ?? [];
  assert.equal(rich.length, 2);
  assert.equal(rich[0]?.text.content.length, NOTION_TEXT_LIMIT);
  assert.equal(rich[1]?.text.content.length, 500);
  // 조용히 자르면 올린 글이 원본과 다른데 아무 표시가 없다.
  assert.equal(rich.map((r) => r.text.content).join(""), long);
});

test("블록이 100개를 넘으면 요청을 나눈다 — 넘기면 요청 전체가 거절된다", () => {
  const blocks = notionBlocksOf(
    Array.from({ length: NOTION_BLOCK_LIMIT + 5 }, (_, i) => `- 항목 ${i}`).join("\n"),
  );
  assert.equal(blocks.length, NOTION_BLOCK_LIMIT + 5);

  const batches = notionBlockBatches(blocks);
  assert.equal(batches.length, 2);
  assert.equal(batches[0]?.length, NOTION_BLOCK_LIMIT);
  assert.equal(batches[1]?.length, 5);
});

test("블록이 없으면 요청도 없다", () => {
  assert.deepEqual(notionBlockBatches([]), []);
});

test("꼬리 문단이 출처와 '여기서 고치면 덮인다' 를 말한다", () => {
  const foot = notionFooter({
    author: "안용식",
    updatedAt: "2026-11-24T15:30:00.000Z",
    appUrl: "https://sr.example.lab",
    noteId: 7,
  });
  const text = textOf(foot);
  assert.match(text, /안용식/);
  assert.match(text, /2026-11-24 15:30/);
  assert.match(text, /https:\/\/sr\.example\.lab\/notes\?note=7/);
  // 이 한 줄이 없으면 노션에서 고친 사람은 다음 올리기에 글이 덮이는 것을 모른다.
  assert.match(text, /덮입니다/);
});

test("작성자를 모르면 그렇게 적는다 — 빈 칸으로 두면 누가 올렸는지 잃는다", () => {
  const foot = notionFooter({ author: "", updatedAt: "2026-11-24T00:00:00.000Z", appUrl: "x", noteId: 1 });
  assert.match(textOf(foot), /작성자 미상/);
});
