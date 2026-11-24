/**
 * 글 안의 `@이름` 을 **실제 Jira 멘션**으로 바꾼다.
 *
 * ## 왜 글자로 두면 안 되나
 *
 * 본문에 `@민수` 라고 글자로 적으면 Jira 에서는 그냥 글자다 — 그 사람에게 **알림이
 * 가지 않고**, 그 사람의 "내가 언급된 항목" 에도 잡히지 않는다. 적은 사람은 알렸다고
 * 믿고, 받는 사람은 모른다. 그 간극이 이 파일이 있는 이유다.
 *
 * ADF 의 멘션 노드는 이렇게 생겼다.
 *
 *     { type: "mention", attrs: { id: "<accountId>", text: "@민수" } }
 *
 * `id` 가 **accountId** 다. 그래서 팀원이 `/team` 에서 자기 Jira 계정 id 를 넣어 두지
 * 않으면 멘션을 만들 수 없다 — 그때는 **글자로 남긴다.** 조용히 지우면 그 이름이
 * 본문에서 사라져 "누구 얘기였는지" 를 잃는다.
 *
 * ## 이름 맞추기와 줄 가르기는 여기 없다
 *
 * `@` 를 찾아 이름과 맞추는 규칙, 빈 줄로 문단을 가르는 규칙은 lib/mentionSpans.ts 에
 * 있다. 같은 판정을 **우리 화면도** 써야 하기 때문이다 — 메모만 저장한 일정은 Jira 로
 * 가지 않는다(lib/memoBlocks.ts). 규칙이 갈라지면 화면에서는 이름이 강조되는데 Jira
 * 에는 멘션이 안 가는 상태가 생기고, 적은 사람은 알렸다고 믿는다.
 *
 * 순수 함수다 — DB·네트워크를 모른다. 부르는 쪽이 팀원 목록을 넘긴다.
 */
import { adfText, type AdfNode } from "./adf.ts";
import { mentionSpans, textBlocks, type MentionablePerson } from "./mentionSpans.ts";

// 정본은 lib/mentionSpans.ts 다. 이 경로로 가져가던 곳이 많아 그대로 내보낸다.
export type { MentionablePerson };

/** 멘션 노드 하나. */
export function adfMention(accountId: string, label: string): AdfNode {
  return { type: "mention", attrs: { id: accountId, text: `@${label}` } };
}

export interface MentionResult {
  readonly nodes: AdfNode[];
  /** 맞췄지만 accountId 가 없어 글자로 남은 이름들. 화면이 알려 주는 데 쓴다. */
  readonly unlinked: readonly string[];
}

/**
 * 한 줄(또는 한 문단)의 글을 멘션이 섞인 노드 배열로 바꾼다.
 *
 * 조각을 가르는 일은 mentionSpans 가 한다. 여기서는 Jira 계정이 없는 사람을 **글자로**
 * 되돌리는 것만 결정한다 — 조용히 지우면 누구 얘기였는지를 잃는다.
 */
export function adfTextWithMentions(
  text: string,
  people: readonly MentionablePerson[],
): MentionResult {
  const split = mentionSpans(text, people);
  const nodes: AdfNode[] = [];
  for (const span of split.spans) {
    if (span.kind === "text") {
      nodes.push(...adfText(span.text));
    } else if (span.accountId === "") {
      nodes.push(...adfText(`@${span.label}`));
    } else {
      nodes.push(adfMention(span.accountId, span.label));
    }
  }
  return { nodes, unlinked: split.unlinked };
}

/**
 * 여러 줄 글 → 문단들. 멘션을 살린다.
 *
 * `lib/adf.ts` 의 adfLines 와 같은 규칙으로 줄을 가른다(빈 줄이 문단을 나누고, 문단
 * 안의 줄바꿈은 hardBreak). 거기 함수를 고치지 않고 따로 둔 이유는, 멘션은 **사람
 * 목록이 있어야** 만들 수 있어서다 — adfLines 는 글만 받는다.
 */
export function adfLinesWithMentions(
  text: string,
  people: readonly MentionablePerson[],
): MentionResult {
  const unlinked: string[] = [];
  const nodes: AdfNode[] = textBlocks(text).map((lines) => {
    const parts: AdfNode[] = [];
    lines.forEach((line, index) => {
      if (index > 0) parts.push({ type: "hardBreak" });
      const result = adfTextWithMentions(line, people);
      parts.push(...result.nodes);
      for (const name of result.unlinked) {
        if (!unlinked.includes(name)) unlinked.push(name);
      }
    });
    return parts.length === 0 ? { type: "paragraph" } : { type: "paragraph", content: parts };
  });

  return { nodes, unlinked };
}
