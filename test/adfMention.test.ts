/**
 * `@이름` → 실제 Jira 멘션.
 *
 * 글자로 두면 **알림이 가지 않는다.** 적은 사람은 알렸다고 믿고 받는 사람은 모른다 —
 * 그 간극이 이 기능의 이유다. 그래서 세 가지를 잠근다.
 *   - 맞으면 멘션 노드(accountId 가 들어간다)
 *   - Jira 계정이 없으면 **글자로 남기고** 그 사실을 알린다(조용히 지우지 않는다)
 *   - 이메일 주소처럼 멘션이 아닌 `@` 는 건드리지 않는다
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AdfNode } from "../lib/adf.ts";
import { adfLinesWithMentions, adfTextWithMentions } from "../lib/adfMention.ts";

const PEOPLE = [
  { displayName: "안용식", loginId: "yongsik", jiraAccountId: "acct-1" },
  { displayName: "김민수", loginId: "minsu", jiraAccountId: "acct-2" },
  { displayName: "박연결없음", loginId: "nolink", jiraAccountId: "" },
];

/** 노드에서 글자만 이어 붙인다(멘션은 attrs.text). */
function flatten(nodes: readonly AdfNode[]): string {
  return nodes
    .map((n) => {
      if (n.type === "mention") return String(n.attrs?.text ?? "");
      if (n.type === "hardBreak") return "\n";
      return n.text ?? "";
    })
    .join("");
}

test("이름이 맞으면 멘션 노드가 된다", () => {
  const { nodes, unlinked } = adfTextWithMentions("작업은 @안용식 이 맡습니다", PEOPLE);
  const mention = nodes.find((n) => n.type === "mention");
  assert.ok(mention !== undefined, "멘션 노드가 있어야 알림이 간다");
  assert.deepEqual(mention.attrs, { id: "acct-1", text: "@안용식" });
  assert.equal(flatten(nodes), "작업은 @안용식 이 맡습니다");
  assert.deepEqual(unlinked, []);
});

test("아이디로도 멘션된다", () => {
  const { nodes } = adfTextWithMentions("@yongsik 확인 부탁", PEOPLE);
  const mention = nodes.find((n) => n.type === "mention");
  assert.equal(mention?.attrs?.id, "acct-1");
  assert.equal(mention?.attrs?.text, "@안용식", "표시는 이름으로 한다");
});

test("아이디 대소문자를 접는다", () => {
  const { nodes } = adfTextWithMentions("@YongSik 확인", PEOPLE);
  assert.equal(nodes.find((n) => n.type === "mention")?.attrs?.id, "acct-1");
});

test("여러 명을 멘션한다", () => {
  const { nodes } = adfTextWithMentions("@안용식 @김민수 같이 봅시다", PEOPLE);
  const ids = nodes.filter((n) => n.type === "mention").map((n) => n.attrs?.id);
  assert.deepEqual(ids, ["acct-1", "acct-2"]);
});

test("Jira 계정이 없는 사람은 글자로 남고, 알려 준다", () => {
  // 조용히 지우면 그 이름이 본문에서 사라져 "누구 얘기였는지" 를 잃는다.
  const { nodes, unlinked } = adfTextWithMentions("@박연결없음 확인 부탁", PEOPLE);
  assert.equal(nodes.filter((n) => n.type === "mention").length, 0);
  assert.equal(flatten(nodes), "@박연결없음 확인 부탁");
  assert.deepEqual(unlinked, ["박연결없음"]);
});

test("모르는 이름은 그대로 글자다", () => {
  const { nodes, unlinked } = adfTextWithMentions("@없는사람 확인", PEOPLE);
  assert.equal(nodes.filter((n) => n.type === "mention").length, 0);
  assert.equal(flatten(nodes), "@없는사람 확인");
  assert.deepEqual(unlinked, [], "우리 팀원이 아니면 알릴 것도 없다");
});

test("이메일 주소의 @ 는 건드리지 않는다", () => {
  const { nodes } = adfTextWithMentions("메일은 yongsik@example.com 입니다", PEOPLE);
  assert.equal(nodes.filter((n) => n.type === "mention").length, 0);
  assert.equal(flatten(nodes), "메일은 yongsik@example.com 입니다");
});

test("긴 이름을 먼저 맞춘다", () => {
  // 짧은 후보를 먼저 맞추면 이름이 쪼개져 "용식" 이 글자로 남는다.
  const people = [
    { displayName: "안", loginId: "a", jiraAccountId: "short" },
    { displayName: "안용식", loginId: "yongsik", jiraAccountId: "long" },
  ];
  const { nodes } = adfTextWithMentions("@안용식 님", people);
  assert.equal(nodes.find((n) => n.type === "mention")?.attrs?.id, "long");
  assert.equal(flatten(nodes), "@안용식 님");
});

test("이름의 일부만 맞는 경우는 멘션하지 않는다", () => {
  // "@안용식훈" 은 "안용식" 으로 잘라 맞추면 안 된다.
  const { nodes } = adfTextWithMentions("@안용식훈 님", PEOPLE);
  assert.equal(nodes.filter((n) => n.type === "mention").length, 0);
  assert.equal(flatten(nodes), "@안용식훈 님");
});

test("문장 맨 앞·맨 끝의 멘션도 된다", () => {
  const head = adfTextWithMentions("@안용식", PEOPLE);
  assert.equal(head.nodes.length, 1);
  assert.equal(head.nodes[0]?.type, "mention");

  const tail = adfTextWithMentions("담당 @김민수", PEOPLE);
  assert.equal(tail.nodes[tail.nodes.length - 1]?.type, "mention");
});

test("@ 만 있으면 그냥 글자다", () => {
  const { nodes } = adfTextWithMentions("@ 그리고 @@", PEOPLE);
  assert.equal(nodes.filter((n) => n.type === "mention").length, 0);
  assert.equal(flatten(nodes), "@ 그리고 @@");
});

test("빈 글은 노드를 만들지 않는다", () => {
  // ADF 는 글자 없는 text 노드를 거부한다.
  assert.deepEqual(adfTextWithMentions("", PEOPLE).nodes, []);
});

/* ------------------------------------------------------------------ *
 * 여러 줄
 * ------------------------------------------------------------------ */

test("빈 줄이 문단을 가르고, 문단 안 줄바꿈은 hardBreak 다", () => {
  const { nodes } = adfLinesWithMentions("첫 줄 @안용식\n둘째 줄\n\n새 문단 @김민수", PEOPLE);
  assert.equal(nodes.length, 2, "빈 줄로 두 문단");

  const first = nodes[0]?.content ?? [];
  assert.equal(flatten(first), "첫 줄 @안용식\n둘째 줄");
  assert.ok(first.some((n) => n.type === "hardBreak"));

  const second = nodes[1]?.content ?? [];
  assert.ok(second.some((n) => n.type === "mention"));
});

test("여러 줄에서도 연결 안 된 사람을 모아 알린다", () => {
  const { unlinked } = adfLinesWithMentions("@박연결없음 확인\n\n다시 @박연결없음", PEOPLE);
  assert.deepEqual(unlinked, ["박연결없음"], "같은 사람을 두 번 세지 않는다");
});

test("빈 글은 문단도 만들지 않는다", () => {
  assert.deepEqual(adfLinesWithMentions("   \n\n  ", PEOPLE).nodes, []);
});
