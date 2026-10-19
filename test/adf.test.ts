/**
 * ADF 조립 규칙.
 *
 * Jira v3 는 평문을 받지 않는다. 모양이 어긋나면 400 이고, 그 400 은 SR 등록 흐름
 * 안에서 나므로 원인이 멀리 보인다. 그래서 **ADF 가 거부하는 모양을 만들지 않는 것**을
 * 여기서 잠근다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adfBullets, adfCode, adfDoc, adfHeading, adfLines, adfLink, adfParagraph, adfText,
} from "../lib/adf.ts";

/*
 * **빈 글자 노드를 만들지 않는다.** `{"type":"text","text":""}` 는 ADF 가 거부한다.
 */
test("빈 글자는 노드를 만들지 않는다", () => {
  assert.deepEqual(adfText(""), []);
  assert.deepEqual(adfText("글"), [{ type: "text", text: "글" }]);
});

test("조각이 없는 문단은 글자 없는 문단이다(빈 줄)", () => {
  assert.deepEqual(adfParagraph(), { type: "paragraph" });
  assert.deepEqual(adfParagraph(""), { type: "paragraph" }, "빈 글자만 주어도 같다");
});

test("문단은 글자와 조각을 섞어 받는다", () => {
  const p = adfParagraph("문서: ", adfLink("보기", "https://example.test/x"));
  assert.deepEqual(p.content, [
    { type: "text", text: "문서: " },
    { type: "text", text: "보기", marks: [{ type: "link", attrs: { href: "https://example.test/x" } }] },
  ]);
});

// 보일 글자가 없으면 주소를 글자로 쓴다 — 링크가 안 보이는 것이 더 나쁘다.
test("링크에 글자가 없으면 주소를 보여 준다", () => {
  assert.equal(adfLink("", "https://example.test/x")[0]?.text, "https://example.test/x");
  assert.deepEqual(adfLink("보기", ""), [], "주소가 없으면 링크가 아니다");
});

test("제목 레벨은 1~6 으로 가둔다", () => {
  assert.equal(adfHeading(3, "제목").attrs?.level, 3);
  assert.equal(adfHeading(0, "제목").attrs?.level, 1);
  assert.equal(adfHeading(99, "제목").attrs?.level, 6);
});

/*
 * 빈 `bulletList` 는 ADF 가 거부한다. 항목이 없으면 null 을 줘서 부르는 쪽이 그 자리를
 * 아예 빼게 한다.
 */
test("항목이 없는 글머리는 null 이다", () => {
  assert.equal(adfBullets([]), null);
  assert.equal(adfBullets(["", "   "]), null);
  const list = adfBullets(["첫째", "", " 둘째 "]);
  assert.equal(list?.content?.length, 2, "빈 항목은 버린다");
  assert.equal(list?.content?.[1]?.content?.[0]?.content?.[0]?.text, "둘째", "앞뒤 공백을 떼었다");
});

/*
 * `content: []` 인 문서는 Jira 가 거부한다. 그 400 은 "본문이 비었다" 가 아니라 모양
 * 오류로 보여 원인을 가린다.
 */
test("빈 문서는 빈 문단 하나를 갖는다", () => {
  const doc = adfDoc([]);
  assert.equal(doc.type, "doc");
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.content, [{ type: "paragraph" }]);
});

test("null 자리는 버린다", () => {
  const doc = adfDoc([adfParagraph("하나"), null, adfBullets([]), adfParagraph("둘")]);
  assert.equal(doc.content.length, 2);
});

test("코드 블록은 언어를 붙일 수도, 안 붙일 수도 있다", () => {
  assert.equal(adfCode("ls -al", "bash").attrs?.language, "bash");
  assert.equal(adfCode("ls -al").attrs, undefined, "언어가 없으면 attrs 를 넣지 않는다");
});

test("여러 줄은 빈 줄로 문단을 가르고 줄바꿈은 지킨다", () => {
  const nodes = adfLines("첫 문단 첫 줄\n첫 문단 둘째 줄\n\n둘째 문단");
  assert.equal(nodes.length, 2);
  assert.deepEqual(nodes[0]?.content, [
    { type: "text", text: "첫 문단 첫 줄" },
    { type: "hardBreak" },
    { type: "text", text: "첫 문단 둘째 줄" },
  ]);
  assert.equal(nodes[1]?.content?.[0]?.text, "둘째 문단");
});

test("빈 글은 문단을 만들지 않는다", () => {
  assert.deepEqual(adfLines(""), []);
  assert.deepEqual(adfLines("\n\n   \n"), []);
});

/*
 * 조립한 문서 **전체**에 빈 글자 노드가 없어야 한다. 하나만 섞여도 Jira 가 문서째로
 * 거부하므로, 조각 단위 시험만으로는 부족하다.
 */
test("조립 결과 어디에도 빈 글자 노드가 없다", () => {
  const doc = adfDoc([
    adfHeading(3, ""),
    adfParagraph("", adfText(""), adfLink("", "")),
    adfBullets(["", "항목"]),
    ...adfLines("글\n\n"),
    adfCode(""),
  ]);
  const walk = (node: { text?: string; content?: unknown[] }): void => {
    if (node.text !== undefined) assert.notEqual(node.text, "", "빈 글자 노드가 있다");
    for (const child of (node.content ?? []) as Array<typeof node>) walk(child);
  };
  walk(doc as unknown as { content?: unknown[] });
});
