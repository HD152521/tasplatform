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
 * ## 이름을 어떻게 맞추나
 *
 * 긴 이름을 먼저 본다. `@안용식` 과 `@안` 이 둘 다 후보일 때 `@안` 을 먼저 맞추면
 * 뒤의 "용식" 이 글자로 남아 이름이 쪼개진다. 그래서 후보를 **길이 내림차순**으로
 * 정렬해 훑는다.
 *
 * 순수 함수다 — DB·네트워크를 모른다. 부르는 쪽이 팀원 목록을 넘긴다.
 */
import { adfText, type AdfNode } from "./adf.ts";

export interface MentionablePerson {
  /** 화면에 보이는 이름. `@안용식` 의 "안용식". */
  readonly displayName: string;
  /** 로그인 아이디. `@yongsik` 로도 적을 수 있게 한다. */
  readonly loginId: string;
  /** Jira accountId. 비어 있으면 멘션을 만들 수 없다. */
  readonly jiraAccountId: string;
}

/** 멘션 노드 하나. */
export function adfMention(accountId: string, label: string): AdfNode {
  return { type: "mention", attrs: { id: accountId, text: `@${label}` } };
}

interface Candidate {
  readonly needle: string;
  readonly label: string;
  readonly accountId: string;
}

/**
 * 맞출 후보 목록. 이름과 아이디를 모두 받고, **긴 것부터** 본다.
 *
 * accountId 가 없는 사람도 후보에 넣는다 — 글자를 그대로 두되 "멘션이 안 됐다" 를
 * 부르는 쪽이 알 수 있어야 한다(mentionGaps).
 */
function candidatesOf(people: readonly MentionablePerson[]): Candidate[] {
  const out: Candidate[] = [];
  for (const person of people) {
    const label = person.displayName.trim() === "" ? person.loginId : person.displayName.trim();
    for (const needle of [person.displayName.trim(), person.loginId.trim()]) {
      if (needle === "") continue;
      if (out.some((c) => c.needle.toLowerCase() === needle.toLowerCase())) continue;
      out.push({ needle, label, accountId: person.jiraAccountId.trim() });
    }
  }
  return out.sort((a, b) => b.needle.length - a.needle.length);
}

/** `@` 뒤에 올 수 있는 글자인지. 한글·영숫자·점·밑줄·하이픈까지 본다. */
const NAME_CHAR = /[0-9A-Za-z가-힣._-]/;

export interface MentionResult {
  readonly nodes: AdfNode[];
  /** 맞췄지만 accountId 가 없어 글자로 남은 이름들. 화면이 알려 주는 데 쓴다. */
  readonly unlinked: readonly string[];
}

/**
 * 한 줄(또는 한 문단)의 글을 멘션이 섞인 노드 배열로 바꾼다.
 *
 * `@` 가 이름과 맞지 않으면 **그대로 글자로 둔다.** 이메일 주소(`a@b.com`)처럼 `@`
 * 앞에 글자가 붙어 있는 경우도 건드리지 않는다 — 그건 멘션이 아니다.
 */
export function adfTextWithMentions(
  text: string,
  people: readonly MentionablePerson[],
): MentionResult {
  const candidates = candidatesOf(people);
  const nodes: AdfNode[] = [];
  const unlinked: string[] = [];
  let buffer = "";

  const flush = (): void => {
    if (buffer !== "") {
      nodes.push(...adfText(buffer));
      buffer = "";
    }
  };

  let i = 0;
  while (i < text.length) {
    const char = text[i] as string;
    if (char !== "@") {
      buffer += char;
      i += 1;
      continue;
    }

    // `@` 앞이 이름 글자면 멘션이 아니다(이메일 주소 등).
    const before = i === 0 ? "" : (text[i - 1] as string);
    if (before !== "" && NAME_CHAR.test(before)) {
      buffer += char;
      i += 1;
      continue;
    }

    const rest = text.slice(i + 1);
    const hit = candidates.find((c) => {
      if (!rest.toLowerCase().startsWith(c.needle.toLowerCase())) return false;
      // 더 긴 이름의 일부를 잘라 맞추지 않는다 — `@안용식` 에서 `안용` 만 맞으면 안 된다.
      const after = rest.slice(c.needle.length, c.needle.length + 1);
      return after === "" || !NAME_CHAR.test(after);
    });

    if (hit === undefined) {
      buffer += char;
      i += 1;
      continue;
    }

    flush();
    if (hit.accountId === "") {
      // Jira 계정이 연결되지 않은 사람. 글자로 남기고 그 사실을 알린다.
      nodes.push(...adfText(`@${hit.label}`));
      if (!unlinked.includes(hit.label)) unlinked.push(hit.label);
    } else {
      nodes.push(adfMention(hit.accountId, hit.label));
    }
    i += 1 + hit.needle.length;
  }

  flush();
  return { nodes, unlinked };
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
  const blocks = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== "");

  const nodes: AdfNode[] = blocks.map((block) => {
    const parts: AdfNode[] = [];
    block.split("\n").forEach((line, index) => {
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
