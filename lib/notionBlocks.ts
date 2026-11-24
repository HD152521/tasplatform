/**
 * 메모 글 → 노션 블록.
 *
 * ## 왜 글을 통째로 넘기지 않나
 *
 * 노션은 글 한 덩어리를 받지 않는다. 블록 배열을 받는다. 본문을 한 문단으로 밀어 넣으면
 * 글머리 기호가 `-` 글자로 남고 줄바꿈도 뭉친다 — **올리는 뜻이 "정리해서 올리는" 것인데
 * 정리가 거기서 풀린다.** 그래서 우리가 이미 쓰는 가름(lib/memoBlocks.ts)을 노션 블록에
 * 그대로 옮긴다. 화면에서 목록으로 보이는 것이 노션에서도 목록이다.
 *
 * ## 멘션은 굵은 글자로
 *
 * `@이름` 을 노션 멘션으로 만들려면 그 사람의 **노션 계정 id** 가 있어야 한다. 우리는
 * 그것을 모른다(팀원 표에는 Jira accountId 만 있다). 없는 것을 추측해 넣으면 요청이
 * 거절당하거나 엉뚱한 사람이 불린다. 그래서 굵은 글자로만 둔다 — 글에서 눈에 띄고,
 * 아무도 잘못 호출되지 않는다.
 *
 * ## 번호는 노션이 다시 센다
 *
 * 우리 화면은 사람이 적은 번호를 그대로 보여 준다(`1. 1. 1.` 이면 그대로). 노션의
 * 번호 목록 블록은 **번호를 담을 칸이 없다** — 노션이 스스로 1·2·3 으로 센다. 적힌
 * 번호를 지키려고 평범한 문단으로 올리면 노션에서 목록이 아니게 되고, 그게 더 큰
 * 손실이다(정리해서 올리는 것이 이 기능의 목적이다). 그래서 번호 목록은 노션 목록으로
 * 올리고 번호는 노션에 맡긴다.
 *
 * ## 한계 두 개를 여기서 지킨다
 *
 *   - rich text 한 조각은 2000자까지다. 넘으면 **잘라 버리지 않고 쪼갠다.**
 *   - 한 요청에 블록 100개까지다. 쪼개는 것은 부르는 쪽 일이라 상수만 내보낸다.
 *
 * 순수 모듈이다 — 네트워크를 모른다. 시험이 블록 모양을 그대로 확인할 수 있어야 한다.
 */
import { memoBlocks } from "./memoBlocks.ts";
import type { MentionSpan, MentionablePerson } from "./mentionSpans.ts";

/** 한 요청에 보낼 수 있는 블록 수. 노션 API 상한이다. */
export const NOTION_BLOCK_LIMIT = 100;

/** rich text 한 조각의 글자 수 상한. 노션 API 상한이다. */
export const NOTION_TEXT_LIMIT = 2000;

export interface NotionRichText {
  readonly type: "text";
  readonly text: { readonly content: string };
  readonly annotations?: { readonly bold: true };
}

export interface NotionBlock {
  readonly object: "block";
  readonly type: "paragraph" | "bulleted_list_item" | "numbered_list_item";
  readonly paragraph?: { readonly rich_text: readonly NotionRichText[] };
  readonly bulleted_list_item?: { readonly rich_text: readonly NotionRichText[] };
  readonly numbered_list_item?: { readonly rich_text: readonly NotionRichText[] };
}

/**
 * 글자를 상한에 맞춰 쪼갠다.
 *
 * 잘라 버리지 않는다. 긴 글을 조용히 자르면 **올린 글이 원본과 다른데 아무 표시가
 * 없다.** 그게 이 도구에서 가장 하면 안 되는 종류의 실패다.
 */
function chunk(text: string): string[] {
  if (text.length <= NOTION_TEXT_LIMIT) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += NOTION_TEXT_LIMIT) {
    out.push(text.slice(i, i + NOTION_TEXT_LIMIT));
  }
  return out;
}

function richText(spans: readonly MentionSpan[]): NotionRichText[] {
  const out: NotionRichText[] = [];
  for (const span of spans) {
    const content = span.kind === "text" ? span.text : "@" + span.label;
    if (content === "") continue;
    for (const piece of chunk(content)) {
      out.push(
        span.kind === "text"
          ? { type: "text", text: { content: piece } }
          : { type: "text", text: { content: piece }, annotations: { bold: true } },
      );
    }
  }
  // 빈 문단도 블록으로는 있어야 한다 — 없으면 노션이 거절한다.
  return out.length === 0 ? [{ type: "text", text: { content: "" } }] : out;
}

function block(
  type: NotionBlock["type"],
  spans: readonly MentionSpan[],
): NotionBlock {
  const rich = { rich_text: richText(spans) };
  if (type === "bulleted_list_item") return { object: "block", type, bulleted_list_item: rich };
  if (type === "numbered_list_item") return { object: "block", type, numbered_list_item: rich };
  return { object: "block", type, paragraph: rich };
}

/**
 * 메모 본문 → 노션 블록 배열.
 *
 * 문단 안의 줄바꿈은 한 블록 안에 `\n` 으로 남긴다. 줄마다 블록을 만들면 노션에서
 * 문단 사이 간격이 생겨 **원래 한 덩어리였던 글이 흩어져 보인다.**
 */
export function notionBlocksOf(
  body: string,
  people: readonly MentionablePerson[] = [],
): NotionBlock[] {
  const layout = memoBlocks(body, people);
  const out: NotionBlock[] = [];

  for (const chunkBlock of layout.blocks) {
    if (chunkBlock.kind === "para") {
      const spans: MentionSpan[] = [];
      chunkBlock.lines.forEach((line, index) => {
        if (index > 0) spans.push({ kind: "text", text: "\n" });
        spans.push(...line);
      });
      out.push(block("paragraph", spans));
      continue;
    }
    const type = chunkBlock.kind === "bullet" ? "bulleted_list_item" : "numbered_list_item";
    for (const item of chunkBlock.items) {
      out.push(block(type, item.spans));
    }
  }

  return out;
}

/**
 * 블록 배열을 요청 단위로 나눈다. 100개를 넘으면 노션이 **요청 전체를** 거절한다.
 */
export function notionBlockBatches(blocks: readonly NotionBlock[]): NotionBlock[][] {
  const out: NotionBlock[][] = [];
  for (let i = 0; i < blocks.length; i += NOTION_BLOCK_LIMIT) {
    out.push(blocks.slice(i, i + NOTION_BLOCK_LIMIT));
  }
  return out;
}

/**
 * 어디서 온 글인지 적는 꼬리 문단.
 *
 * 노션에서 글만 보는 사람은 이게 손으로 적은 글인지 도구가 올린 글인지 모른다. 고치려면
 * 어디로 가야 하는지도 모른다 — **노션에서 고쳐도 다음 올리기에 덮인다.** 그 한 줄을
 * 반드시 남긴다.
 */
export function notionFooter(input: {
  readonly author: string;
  readonly updatedAt: string;
  readonly appUrl: string;
  readonly noteId: number;
}): NotionBlock {
  const who = input.author.trim() === "" ? "작성자 미상" : input.author.trim();
  const when = input.updatedAt.slice(0, 16).replace("T", " ");
  return block("paragraph", [
    {
      kind: "text",
      text:
        `메모장 · ${who} · ${when}\n`
        + `${input.appUrl}/notes?note=${input.noteId}\n`
        + "이 페이지는 메모장에서 올린 것입니다. 여기서 고친 내용은 다시 올릴 때 덮입니다.",
    },
  ]);
}
