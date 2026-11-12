/**
 * SR 종료 뒤 Jira 티켓 본문에 조치 방향 적어 넣기.
 *
 * 본문은 **통째로 갈아 끼우는** API 다(PUT). 판정이 틀리면 등록 때 적어 둔 문제 상황이
 * 사라지거나, 회차마다 같은 절이 하나씩 늘어난다. 둘 다 티켓을 열어 보기 전에는 모른다.
 * 그래서 규칙을 순수 함수로 떼어 여기서 잠근다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { adfDoc, adfHeading, adfParagraph, type AdfNode } from "../lib/adf.ts";
import { SOLUTION_HEADING, solutionNodes, solutionPatch } from "../lib/jiraSolution.ts";

const URL = "https://example.atlassian.net/wiki/spaces/SR/pages/1";

/** 등록 때 만든 본문 — 문제 상황만 있다. */
const ORIGINAL = adfDoc([
  adfHeading(3, "Case 12345678"),
  adfParagraph("디스크가 기존 AZ 에 남아 있습니다."),
  adfParagraph("제품/컴포넌트: VMware vSphere ESXi / ESXi Host Management"),
]);

/** 노드들에서 글자만 모은다. */
function textOf(nodes: readonly AdfNode[]): string {
  const one = (node: AdfNode): string =>
    `${node.text ?? ""}${(node.content ?? []).map(one).join("")}`;
  return nodes.map(one).join("\n");
}

function headings(doc: { content: AdfNode[] }): string[] {
  return doc.content
    .filter((node) => node.type === "heading")
    .map((node) => textOf([node]));
}

/* ------------------------------------------------------------------ *
 * 덩어리 만들기
 * ------------------------------------------------------------------ */

test("조치 방향 제목과 내용, 문서 주소를 담는다", () => {
  const nodes = solutionNodes({ result: "메모리 쿼터를 올려 해결했습니다.", pageUrl: URL });
  assert.equal(nodes[0]?.type, "heading");
  assert.equal(textOf([nodes[0] as AdfNode]), SOLUTION_HEADING);
  assert.match(textOf(nodes), /메모리 쿼터를 올려/);
  assert.match(textOf(nodes), /Confluence 에서 보기/);
});

test("주소는 링크로 붙는다", () => {
  const nodes = solutionNodes({ result: "해결", pageUrl: URL });
  const json = JSON.stringify(nodes);
  assert.match(json, /"type":"link"/);
  assert.ok(json.includes(URL));
});

// 결과를 못 뽑았어도 주소는 남긴다 — 링크만 있어도 문서로 갈 수 있다.
test("결과가 없으면 주소만 남긴다", () => {
  const nodes = solutionNodes({ result: "", pageUrl: URL });
  assert.ok(nodes.length >= 2);
  assert.match(textOf(nodes), /Confluence 에서 보기/);
});

/*
 * 제목만 있는 절을 남기면 티켓을 읽는 사람이 **내용이 지워진 줄** 안다.
 * 그래서 적을 것이 없으면 아무것도 만들지 않는다.
 */
test("적을 것이 하나도 없으면 빈 배열이다", () => {
  assert.deepEqual(solutionNodes({ result: "", pageUrl: "" }), []);
  assert.equal(solutionPatch(ORIGINAL, []), null);
});

/* ------------------------------------------------------------------ *
 * 끼워 넣기
 * ------------------------------------------------------------------ */

test("처음에는 본문 끝에 붙인다", () => {
  const nodes = solutionNodes({ result: "해결했습니다.", pageUrl: URL });
  const next = solutionPatch(ORIGINAL, nodes);
  assert.ok(next !== null);
  // 등록 때 적은 문제 상황이 그대로 남아 있어야 한다.
  assert.match(textOf(next.content), /디스크가 기존 AZ 에 남아 있습니다/);
  assert.deepEqual(headings(next), ["Case 12345678", SOLUTION_HEADING]);
});

/*
 * 자동 게시는 조건으로 대상을 고르는 구조라 **같은 건이 다시 집힌다.** 그때마다
 * 덧붙이면 티켓 본문에 같은 절이 쌓인다.
 */
test("두 번 돌아도 절이 늘어나지 않는다", () => {
  const nodes = solutionNodes({ result: "해결했습니다.", pageUrl: URL });
  const once = solutionPatch(ORIGINAL, nodes);
  assert.ok(once !== null);
  // 같은 내용이면 보낼 것이 없다.
  assert.equal(solutionPatch(once, nodes), null);
});

test("내용이 바뀌면 그 자리만 갈아 끼운다", () => {
  const first = solutionPatch(ORIGINAL, solutionNodes({ result: "임시 조치", pageUrl: URL }));
  assert.ok(first !== null);
  const second = solutionPatch(first, solutionNodes({ result: "근본 조치", pageUrl: URL }));
  assert.ok(second !== null);
  assert.match(textOf(second.content), /근본 조치/);
  assert.ok(!textOf(second.content).includes("임시 조치"));
  assert.deepEqual(headings(second), ["Case 12345678", SOLUTION_HEADING]);
});

/*
 * 사람이 조치 방향 **아래에 다른 절**을 적어 둘 수 있다. 우리 덩어리는 다음 제목
 * 전까지다 — 그 뒤를 지우면 사람이 쓴 글이 사라진다.
 */
test("뒤에 사람이 적어 둔 절은 건드리지 않는다", () => {
  const withNote = adfDoc([
    ...(solutionPatch(ORIGINAL, solutionNodes({ result: "임시 조치", pageUrl: URL }))?.content ?? []),
    adfHeading(3, "내부 메모"),
    adfParagraph("다음 점검 때 확인하기로 했습니다."),
  ]);
  const next = solutionPatch(withNote, solutionNodes({ result: "근본 조치", pageUrl: URL }));
  assert.ok(next !== null);
  assert.match(textOf(next.content), /다음 점검 때 확인하기로/);
  assert.deepEqual(headings(next), ["Case 12345678", SOLUTION_HEADING, "내부 메모"]);
});

/*
 * Jira 가 돌려주는 ADF 는 우리가 만든 것과 **키 순서가 다르다.** JSON 을 그대로 비교하면
 * 늘 "달라졌다" 가 되어 회차마다 티켓을 수정하고, 이력이 같은 수정으로 덮인다.
 */
test("키 순서가 달라도 같은 내용으로 본다", () => {
  const nodes = solutionNodes({ result: "해결했습니다.", pageUrl: URL });
  const made = solutionPatch(ORIGINAL, nodes);
  assert.ok(made !== null);
  // 키 순서를 뒤집어 다시 읽은 것처럼 만든다.
  const shuffled = JSON.parse(JSON.stringify(made, (_, value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).reverse());
  })) as { content: AdfNode[] };
  assert.equal(solutionPatch(shuffled, nodes), null);
});

/*
 * 본문을 못 읽었을 때(권한·모양) 덩어리만으로 문서를 만들면 문제 상황이 날아간다.
 * 읽은 것이 없으면 **붙이기만** 한다 — 그 경우 결과물은 덩어리뿐이지만, 덮어쓸 기존
 * 내용이 애초에 없었다는 뜻이다.
 */
test("본문을 읽지 못했어도 덩어리는 만든다", () => {
  const nodes = solutionNodes({ result: "해결했습니다.", pageUrl: URL });
  for (const bad of [null, undefined, "", 42, { type: "paragraph" }, { type: "doc" }]) {
    const next = solutionPatch(bad, nodes);
    assert.ok(next !== null, JSON.stringify(bad));
    assert.deepEqual(headings(next), [SOLUTION_HEADING]);
  }
});

test("표식 글자가 그대로 쓰인다", () => {
  // 이 글자가 자물쇠다. 바꾸면 이미 적어 둔 티켓에서 표식을 못 찾아 절이 두 번 생긴다.
  assert.equal(SOLUTION_HEADING, "조치 방향");
});
