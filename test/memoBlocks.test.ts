/**
 * 메모 글 → 화면이 그릴 덩어리.
 *
 * 이 판정이 틀리면 **Jira 에 올리지 않는 일정의 글이 읽기 어려워진다** — 그 글이 보이는
 * 자리는 우리 화면 하나뿐이다. 그리고 `@이름` 판정은 Jira 본문과 같은 모듈을 쓰므로
 * (lib/mentionSpans.ts), 여기서 강조되는 이름은 Jira 에서도 멘션이 되어야 한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { adfLinesWithMentions } from "../lib/adfMention.ts";
import { memoBlocks, memoPlainText } from "../lib/memoBlocks.ts";
import type { MentionablePerson } from "../lib/mentionSpans.ts";

const PEOPLE: readonly MentionablePerson[] = [
  { displayName: "안용식", loginId: "yongsik", jiraAccountId: "acct-1" },
  { displayName: "민수", loginId: "minsu", jiraAccountId: "" },
];

test("빈 글은 덩어리가 없다 — 화면이 '내용 없음' 을 알아서 그린다", () => {
  assert.deepEqual(memoBlocks("").blocks, []);
  assert.deepEqual(memoBlocks("   \n\n  ").blocks, []);
});

test("빈 줄이 문단을 나눈다 — Jira 본문과 같은 규칙이다", () => {
  const layout = memoBlocks("첫 문단\n둘째 줄\n\n다음 문단");
  assert.equal(layout.blocks.length, 2);
  assert.equal(layout.blocks[0]?.kind, "para");
  assert.deepEqual(memoPlainText(layout), "첫 문단\n둘째 줄\n\n다음 문단");
});

test("- 로 시작하는 줄은 목록이 된다", () => {
  const layout = memoBlocks("- 로그 받기\n- 결과 공유");
  const block = layout.blocks[0];
  assert.equal(block?.kind, "bullet");
  assert.equal(block?.kind === "bullet" ? block.items.length : 0, 2);
  // 기호는 떼고 글만 남는다 — 화면이 기호를 따로 그린다.
  assert.equal(memoPlainText(layout), "· 로그 받기\n· 결과 공유");
});

test("* 와 • 도 같은 목록으로 본다", () => {
  for (const marker of ["*", "\u2022"]) {
    const block = memoBlocks(`${marker} 항목`).blocks[0];
    assert.equal(block?.kind, "bullet", marker);
  }
});

test("기호 뒤에 공백이 없으면 목록이 아니다 — -1 은 글이다", () => {
  const block = memoBlocks("-1시간 지연").blocks[0];
  assert.equal(block?.kind, "para");
});

test("번호는 사람이 적은 그대로 쓴다 — 우리가 고치면 적힌 글과 달라진다", () => {
  const layout = memoBlocks("1. 먼저\n1. 그다음\n3) 마지막");
  const block = layout.blocks[0];
  assert.equal(block?.kind, "number");
  assert.deepEqual(
    block?.kind === "number" ? block.items.map((i) => i.marker) : [],
    ["1.", "1.", "3)"],
  );
});

test("글 줄과 목록 줄이 섞이면 섞인 순서대로 쪼갠다", () => {
  // 머리말 한 줄 + 목록이 가장 흔한 모양이다. 한 덩어리로 묶으면 들여쓰기가 사라진다.
  const layout = memoBlocks("오전 점검 결과\n- A 정상\n- B 지연\n재점검 예정");
  assert.deepEqual(
    layout.blocks.map((b) => b.kind),
    ["para", "bullet", "para"],
  );
});

test("@이름 이 조각으로 갈린다 — 화면이 강조할 수 있어야 한다", () => {
  const layout = memoBlocks("@안용식 확인 부탁", PEOPLE);
  const block = layout.blocks[0];
  assert.equal(block?.kind, "para");
  const spans = block?.kind === "para" ? block.lines[0] ?? [] : [];
  assert.equal(spans[0]?.kind, "mention");
  assert.equal(spans[0]?.kind === "mention" ? spans[0].label : "", "안용식");
});

test("Jira 계정이 없는 사람은 알려 준다 — 올릴 때 글자로만 남는다", () => {
  const layout = memoBlocks("- @민수 공유", PEOPLE);
  assert.deepEqual(layout.unlinked, ["민수"]);
});

test("목록 안의 @이름 도 찾는다", () => {
  const layout = memoBlocks("- @yongsik 에게 전달", PEOPLE);
  assert.equal(memoPlainText(layout), "· @안용식 에게 전달");
});

test("이메일 주소의 @ 는 멘션이 아니다", () => {
  const layout = memoBlocks("메일: a@b.com 으로 보냈습니다", PEOPLE);
  const spans = layout.blocks[0]?.kind === "para" ? layout.blocks[0].lines[0] ?? [] : [];
  assert.ok(spans.every((s) => s.kind === "text"), JSON.stringify(spans));
});

test("문단 줄의 들여쓰기는 지킨다 — 그렇게 뜻을 주는 사람이 있다", () => {
  const layout = memoBlocks("제목\n    들여쓴 줄");
  assert.equal(memoPlainText(layout), "제목\n    들여쓴 줄");
});

test("사람 목록을 안 줘도 돈다 — 이름을 못 맞출 뿐이다", () => {
  const layout = memoBlocks("@안용식 확인");
  assert.deepEqual(layout.unlinked, []);
  assert.equal(memoPlainText(layout), "@안용식 확인");
});

/* ------------------------------------------------------------------ *
 * 계약 — 화면과 Jira 가 같은 이름을 멘션으로 본다
 * ------------------------------------------------------------------ */

test("화면이 강조하는 이름 = Jira 가 멘션으로 만드는 이름", () => {
  /*
   * 두 길이 갈라지면 **화면에서는 이름이 강조되는데 Jira 에는 멘션이 안 가는** 상태가
   * 생긴다. 적은 사람은 알렸다고 믿고 받는 사람은 모른다. 그 거짓말을 여기서 막는다.
   */
  const text = "@안용식 확인 부탁\n\n- @민수 공유\n- a@b.com 회신";

  const highlighted: string[] = [];
  for (const block of memoBlocks(text, PEOPLE).blocks) {
    const spanLists = block.kind === "para" ? block.lines : block.items.map((i) => i.spans);
    for (const spans of spanLists) {
      for (const span of spans) {
        if (span.kind === "mention") highlighted.push(span.label);
      }
    }
  }

  const written = adfLinesWithMentions(text, PEOPLE);
  const mentioned = JSON.stringify(written.nodes).match(/"text":"@[^"]+"/g) ?? [];
  const names = mentioned.map((m) => m.replace('"text":"@', "").replace('"', ""));

  /*
   * 멘션 노드(`attrs.text`)와 계정이 없어 글자로 남은 이름(`@민수`) 둘 다 위 정규식에
   * 걸린다 — 그게 맞다. 화면도 그 둘을 함께 강조하고, 계정이 없는 사람은 따로 알려 준다.
   */
  assert.deepEqual(
    [...highlighted].sort(),
    [...names].sort(),
    `화면 ${JSON.stringify(highlighted)} / Jira ${JSON.stringify(names)}`,
  );
  assert.deepEqual([...memoBlocks(text, PEOPLE).unlinked], [...written.unlinked]);
});
