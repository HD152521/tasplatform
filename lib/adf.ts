/**
 * Atlassian Document Format(ADF) 조립 — 순수 함수.
 *
 * ## 왜 필요한가
 *
 * Jira REST v3 는 `description` 과 댓글 본문을 **평문으로 받지 않는다.** JSON 문서
 * 구조(ADF)를 받는다. 글자를 그대로 넣으면 400 이고, 그 400 은 SR 등록 흐름 안에서
 * 나므로 원인이 멀리 보인다.
 *
 * v2 API 로 평문을 보내는 길도 있지만, 읽기는 이미 v3 를 쓰고 있다(lib/atlassian.ts).
 * 한 모듈이 두 버전을 오가게 두면 어느 쪽 규칙인지 헷갈린다. 그리고 댓글에는
 * **Confluence 링크**가 들어가야 하는데 링크는 ADF 에서 마크로 붙으므로 어차피 필요하다.
 *
 * ## 지키는 규칙
 *
 * - **빈 글자 노드를 만들지 않는다.** `{"type":"text","text":""}` 는 ADF 가 거부한다.
 *   빈 줄은 글자 없는 문단으로 넣는다.
 * - 쓰는 모양만 만든다(문단·제목·글머리·링크·코드). 문서 편집기를 만드는 것이 아니다.
 * - 조립만 한다. 보내는 일은 lib/jiraWrite.ts 가 한다.
 */

export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

export interface AdfDoc {
  type: "doc";
  version: 1;
  content: AdfNode[];
}

/** 글자 한 조각. 빈 글자는 노드를 만들지 않는다(ADF 가 거부한다). */
export function adfText(text: string): AdfNode[] {
  return text === "" ? [] : [{ type: "text", text }];
}

/** 링크가 걸린 글자. 보일 글자가 비면 주소를 글자로 쓴다. */
export function adfLink(text: string, href: string): AdfNode[] {
  const label = text === "" ? href : text;
  if (label === "" || href === "") return [];
  return [{
    type: "text",
    text: label,
    marks: [{ type: "link", attrs: { href } }],
  }];
}

/**
 * 문단. 조각들을 받아 한 문단으로 만든다.
 *
 * 조각이 없으면 **글자 없는 문단**이 된다 — 그게 ADF 의 빈 줄이다.
 */
export function adfParagraph(...parts: Array<AdfNode[] | string>): AdfNode {
  const content = parts.flatMap((p) => (typeof p === "string" ? adfText(p) : p));
  return content.length === 0 ? { type: "paragraph" } : { type: "paragraph", content };
}

/** 제목. 레벨은 1~6 로 가둔다 — 벗어난 값은 ADF 가 거부한다. */
export function adfHeading(level: number, text: string): AdfNode {
  const safe = Math.min(6, Math.max(1, Math.round(level)));
  return { type: "heading", attrs: { level: safe }, content: adfText(text) };
}

/**
 * 글머리 목록. 빈 항목은 버린다.
 *
 * 항목이 하나도 남지 않으면 null — 빈 `bulletList` 는 ADF 가 거부한다. 부르는 쪽이
 * 그 자리를 아예 빼야 한다.
 */
export function adfBullets(items: readonly string[]): AdfNode | null {
  const listItems = items
    .map((t) => t.trim())
    .filter((t) => t !== "")
    .map((t) => ({ type: "listItem", content: [adfParagraph(t)] }));
  return listItems.length === 0 ? null : { type: "bulletList", content: listItems };
}

/** 코드 블록. 명령·설정 구문을 원문대로 보여줄 때 쓴다. */
export function adfCode(text: string, language = ""): AdfNode {
  const attrs = language === "" ? undefined : { language };
  return { type: "codeBlock", ...(attrs ? { attrs } : {}), content: adfText(text) };
}

/**
 * 문서 하나로 묶는다. null 과 빈 자리는 버린다.
 *
 * 내용이 하나도 없으면 **빈 문단 하나**를 넣는다. `content: []` 인 문서는 Jira 가
 * 거부하고, 그 400 은 "본문이 비었다" 가 아니라 모양 오류로 보여 원인을 가린다.
 */
export function adfDoc(blocks: Array<AdfNode | null>): AdfDoc {
  const content = blocks.filter((b): b is AdfNode => b !== null);
  return {
    type: "doc",
    version: 1,
    content: content.length === 0 ? [{ type: "paragraph" }] : content,
  };
}

/**
 * 여러 줄 글을 문단들로. 빈 줄은 문단을 가른다.
 *
 * AI 가 쓴 글이 아니라 **우리가 조립한 짧은 글**을 넣는 자리라, 마크다운을 해석하지
 * 않는다. 줄바꿈만 지킨다.
 */
export function adfLines(text: string): AdfNode[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== "")
    .map((block) => {
      // 한 문단 안의 줄바꿈은 hardBreak 으로 잇는다. 문단을 나누면 간격이 벌어진다.
      const lines = block.split("\n");
      const parts: AdfNode[] = [];
      lines.forEach((line, i) => {
        if (i > 0) parts.push({ type: "hardBreak" });
        parts.push(...adfText(line));
      });
      return { type: "paragraph", content: parts };
    });
}
