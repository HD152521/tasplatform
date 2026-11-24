/**
 * 메모 글을 **화면이 그릴 수 있는 덩어리**로 가른다.
 *
 * ## 왜 필요한가
 *
 * 일정을 Jira 에 올리지 않고 메모로만 남길 수 있다(team_events.jira_wanted). 그러면
 * 그 글이 보이는 자리는 **우리 화면 하나뿐**이다. 전에는 `white-space: pre-wrap` 한
 * 덩어리로 그려서, 글머리 기호를 적어도 들여쓰기가 없고 문단도 구분되지 않았다 —
 * Jira 에 올리던 일정은 Jira 가 정리해 주었는데 메모는 아무도 정리해 주지 않는다.
 *
 * ## 규칙
 *
 * 빈 줄이 덩어리를 나눈다(lib/mentionSpans.ts 의 textBlocks — Jira 본문과 **같은**
 * 규칙이다. 같은 글이 두 곳에서 다르게 끊기면 안 된다).
 *
 * 덩어리 안에서는 줄머리를 본다.
 *
 *     - 항목   * 항목   • 항목      →  bullet
 *     1. 항목  1) 항목  2. 항목     →  number (적힌 번호를 그대로 쓴다)
 *     그 외                         →  para (줄바꿈을 지킨 문단)
 *
 * 목록 줄과 글 줄이 섞여 있으면 **섞인 순서대로** 쪼갠다. 머리말 한 줄 + 목록이 가장
 * 흔한 모양이고, 그걸 한 덩어리로 묶으면 들여쓰기가 다시 사라진다.
 *
 * 번호는 사람이 적은 것을 그대로 보여 준다. `1. 1. 1.` 로 적어 놨는데 화면이 `1. 2. 3.`
 * 으로 고쳐 주면, 그건 적힌 글과 다른 글이다.
 *
 * ## 순수 모듈이다
 *
 * 화면(클라이언트 컴포넌트)이 직접 부른다. node: 나 server-only 를 하나라도 물면
 * 브라우저 번들이 깨진다.
 */
import {
  mentionSpans,
  textBlocks,
  type MentionSpan,
  type MentionablePerson,
} from "./mentionSpans.ts";

/** 목록 한 줄. */
export interface MemoItem {
  /** 번호 목록이면 사람이 적은 번호(`1.`·`2)`), 글머리 기호면 ''. */
  readonly marker: string;
  readonly spans: readonly MentionSpan[];
}

export type MemoBlock =
  | { readonly kind: "para"; readonly lines: readonly (readonly MentionSpan[])[] }
  | { readonly kind: "bullet"; readonly items: readonly MemoItem[] }
  | { readonly kind: "number"; readonly items: readonly MemoItem[] };

/** `- `, `* `, `• ` 로 시작하는 줄. 뒤에 공백이 없으면 목록으로 보지 않는다(`-1` 등). */
const BULLET = /^[-*\u2022]\s+(.*)$/;
/** `1. `, `1) ` 로 시작하는 줄. 번호는 적힌 그대로 쓴다. */
const NUMBER = /^(\d{1,2}[.)])\s+(.*)$/;

interface Parsed {
  readonly kind: MemoBlock["kind"];
  readonly marker: string;
  readonly text: string;
}

function parseLine(line: string): Parsed {
  const trimmed = line.trim();
  const bullet = BULLET.exec(trimmed);
  if (bullet !== null) return { kind: "bullet", marker: "", text: bullet[1] ?? "" };
  const number = NUMBER.exec(trimmed);
  if (number !== null) {
    return { kind: "number", marker: number[1] ?? "", text: number[2] ?? "" };
  }
  // 문단 줄은 **자르지 않는다.** 들여쓰기로 뜻을 주는 사람이 있다.
  return { kind: "para", marker: "", text: line };
}

export interface MemoLayout {
  readonly blocks: readonly MemoBlock[];
  /** 맞췄지만 Jira 계정이 없어 멘션이 안 될 이름들. */
  readonly unlinked: readonly string[];
}

/**
 * 메모 글 → 덩어리 목록.
 *
 * 빈 글은 덩어리 없음이다. 부르는 쪽이 "내용 없음" 을 그리게 둔다 — 여기서 "(없음)"
 * 같은 글자를 만들면 화면이 그걸 지울 수 없다.
 */
export function memoBlocks(
  text: string,
  people: readonly MentionablePerson[] = [],
): MemoLayout {
  const unlinked: string[] = [];
  const spansOf = (line: string): readonly MentionSpan[] => {
    const split = mentionSpans(line, people);
    for (const name of split.unlinked) {
      if (!unlinked.includes(name)) unlinked.push(name);
    }
    return split.spans;
  };

  const blocks: MemoBlock[] = [];
  for (const lines of textBlocks(text)) {
    // 같은 종류가 이어지는 동안 한 덩어리로 모은다.
    let run: Parsed[] = [];
    const flush = (): void => {
      const first = run[0];
      if (first === undefined) return;
      if (first.kind === "para") {
        blocks.push({ kind: "para", lines: run.map((p) => spansOf(p.text)) });
      } else {
        const items = run.map((p) => ({ marker: p.marker, spans: spansOf(p.text) }));
        blocks.push(first.kind === "bullet" ? { kind: "bullet", items } : { kind: "number", items });
      }
      run = [];
    };

    for (const line of lines) {
      const parsed = parseLine(line);
      if (run.length > 0 && (run[0] as Parsed).kind !== parsed.kind) flush();
      run.push(parsed);
    }
    flush();
  }

  return { blocks, unlinked };
}

/** 덩어리를 다시 글로. 미리보기·시험에서 "무엇이 될지" 를 한눈에 보는 데 쓴다. */
export function memoPlainText(layout: MemoLayout): string {
  const spanText = (spans: readonly MentionSpan[]): string =>
    spans.map((s) => (s.kind === "text" ? s.text : `@${s.label}`)).join("");

  return layout.blocks
    .map((block) => {
      if (block.kind === "para") return block.lines.map(spanText).join("\n");
      return block.items
        .map((item) => `${item.marker === "" ? "·" : item.marker} ${spanText(item.spans)}`)
        .join("\n");
    })
    .join("\n\n");
}
