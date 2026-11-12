/**
 * SR 이 끝난 뒤 Jira 티켓 **본문에** 조치 방향을 적어 넣는다 — 순수 함수.
 *
 * ## 왜 댓글만으로는 모자라나
 *
 * 등록 때 만든 티켓 본문에는 **문제 상황만** 있다(lib/jiraSrTicket.ts 의 srTicketBody).
 * 그때는 조치 방향이 없었으니 당연하다. SR 이 끝나면 조치 방향이 나오는데, 그것이
 * 댓글로만 남으면 티켓을 여는 사람은 본문에서 "진행 중" 인 글만 읽고 댓글을 찾아
 * 내려가야 한다. 나중에 같은 문제를 겪는 사람이 검색으로 티켓을 찾았을 때 제일 먼저
 * 보는 자리가 본문이다. 그래서 **본문 끝에 조치 방향과 정리 문서 주소를 적는다.**
 *
 * 댓글은 그대로 둔다 — 댓글은 지켜보는 사람에게 알림이 가고, 본문은 기록으로 남는다.
 *
 * ## 두 번 돌아도 늘어나지 않는다
 *
 * 본문은 **덧붙이는 것이 아니라 그 자리만 갈아 끼운다.** `조치 방향` 제목을 표식으로
 * 삼아, 그 제목부터 **다음 제목 전까지**를 새 내용으로 바꾼다. 다음 제목 뒤는 건드리지
 * 않는다 — 사람이 아래에 적어 둔 다른 절을 지우면 안 된다.
 *
 * 내용이 같으면 `null` 을 돌려준다. 그러면 부르는 쪽이 아예 보내지 않는다 — 티켓 이력에
 * 같은 수정이 여러 번 찍히지 않는다.
 *
 * ## 왜 글자가 아니라 ADF 인가
 *
 * Jira REST v3 의 `description` 은 평문을 받지 않는다(lib/adf.ts 머리말). 그리고 읽어
 * 들인 기존 본문도 ADF 라, 비교와 교체를 같은 자리에서 해야 한다.
 */
import { adfDoc, adfHeading, adfLines, adfLink, adfParagraph, type AdfDoc, type AdfNode } from "./adf.ts";

/**
 * 본문에서 이 덩어리를 찾는 표식.
 *
 * 글자가 곧 자물쇠다 — 이 값을 바꾸면 이미 적어 둔 티켓들에서 표식을 못 찾아 블록이
 * **두 번** 생긴다. 바꿀 일이 있으면 옛 값도 함께 찾아야 한다.
 */
export const SOLUTION_HEADING = "조치 방향";

/** 정리 문서 링크 줄의 머리말. */
const DOC_LABEL = "정리 문서: ";

/** 링크에 보일 글자. */
const DOC_LINK_TEXT = "Confluence 에서 보기";

/** 노드 안의 글자를 모은다. 제목 비교와 내용 비교에 쓴다. */
function textOf(node: AdfNode): string {
  const own = node.text ?? "";
  const kids = (node.content ?? []).map(textOf).join("");
  return `${own}${kids}`;
}

function isHeading(node: AdfNode): boolean {
  return node.type === "heading";
}

/** ADF 문서로 읽을 수 있는 값인가. Jira 가 준 것을 그대로 받으므로 믿지 않는다. */
function contentOf(description: unknown): AdfNode[] {
  if (typeof description !== "object" || description === null) return [];
  const doc = description as { type?: unknown; content?: unknown };
  if (doc.type !== "doc" || !Array.isArray(doc.content)) return [];
  return doc.content as AdfNode[];
}

/**
 * 비교용 글자. **키 순서에 흔들리지 않게** 글자와 주소만 본다.
 *
 * Jira 가 돌려주는 ADF 는 우리가 만든 것과 키 순서가 다르다. JSON 을 그대로 비교하면
 * 늘 "달라졌다" 가 되어 회차마다 티켓을 수정한다.
 */
function blockText(nodes: readonly AdfNode[]): string {
  const hrefs: string[] = [];
  const walk = (node: AdfNode): void => {
    for (const mark of node.marks ?? []) {
      const href = (mark.attrs ?? {}).href;
      if (mark.type === "link" && typeof href === "string") hrefs.push(href);
    }
    for (const kid of node.content ?? []) walk(kid);
  };
  for (const node of nodes) walk(node);
  return `${nodes.map(textOf).join("\n").replace(/\s+/g, " ").trim()}|${hrefs.join(",")}`;
}

/**
 * 본문 끝에 들어갈 조치 방향 덩어리.
 *
 * 결과도 주소도 없으면 **빈 배열**이다 — 제목만 있는 절을 남기면 티켓을 읽는 사람이
 * 내용이 지워진 줄 안다.
 */
export function solutionNodes(input: { result: string; pageUrl: string }): AdfNode[] {
  const result = input.result.trim();
  const url = input.pageUrl.trim();
  if (result === "" && url === "") return [];

  return [
    adfHeading(3, SOLUTION_HEADING),
    ...adfLines(result),
    ...(url === "" ? [] : [adfParagraph(DOC_LABEL, adfLink(DOC_LINK_TEXT, url))]),
  ];
}

/**
 * 기존 본문에 덩어리를 끼운 **새 본문.** 바꿀 것이 없으면 null.
 *
 * 표식(`조치 방향` 제목)이 있으면 그 자리만, 없으면 맨 끝에 붙인다. 본문을 읽지 못했을
 * 때도(권한·모양) 덩어리만으로 문서를 만들지 않는다 — 사람이 적어 둔 문제 상황을
 * 날리는 것이 가장 나쁘다. 그래서 읽은 내용이 비면 **덧붙이기만** 한다.
 */
export function solutionPatch(description: unknown, nodes: readonly AdfNode[]): AdfDoc | null {
  if (nodes.length === 0) return null;

  const content = contentOf(description);
  const at = content.findIndex((node) => isHeading(node) && textOf(node).trim() === SOLUTION_HEADING);

  if (at === -1) return adfDoc([...content, ...nodes]);

  // 표식 다음 제목까지가 우리 덩어리다. 그 뒤는 사람이 적은 다른 절일 수 있다.
  const after = content.findIndex((node, i) => i > at && isHeading(node));
  const end = after === -1 ? content.length : after;

  if (blockText(content.slice(at, end)) === blockText(nodes)) return null;
  return adfDoc([...content.slice(0, at), ...nodes, ...content.slice(end)]);
}
