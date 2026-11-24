/**
 * 글 안의 `@이름` 을 찾아 **조각으로 가른다.**
 *
 * 이 판정이 두 곳에서 쓰인다 —
 *   Jira 본문: 조각을 ADF 멘션 노드로 바꾼다(lib/adfMention.ts)
 *   우리 화면: 조각을 강조해 보여 준다(lib/memoBlocks.ts → app/calendar)
 *
 * 그래서 규칙을 여기 한 벌만 둔다. 갈라지면 **화면에서는 이름이 강조되는데 Jira 에는
 * 멘션이 안 가는** 상태가 생기고, 적은 사람은 알렸다고 믿는다. 그 거짓말이 이 파일을
 * 따로 떼어 둔 이유다.
 *
 * 순수 함수다 — DB·네트워크를 모른다. 부르는 쪽이 팀원 목록을 넘긴다.
 */

export interface MentionablePerson {
  /** 화면에 보이는 이름. `@안용식` 의 "안용식". */
  readonly displayName: string;
  /** 로그인 아이디. `@yongsik` 로도 적을 수 있게 한다. */
  readonly loginId: string;
  /** Jira accountId. 비어 있으면 멘션을 만들 수 없다. */
  readonly jiraAccountId: string;
}

/** 글 조각. 멘션이면 누구인지까지 들고 있다. */
export type MentionSpan =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "mention";
      /** 보여 줄 이름. 적힌 글자가 아니라 팀원의 이름이다(`@yongsik` → `안용식`). */
      readonly label: string;
      /** 비어 있으면 Jira 멘션을 만들 수 없다 — 글자로만 남는다. */
      readonly accountId: string;
    };

export interface MentionSplit {
  readonly spans: readonly MentionSpan[];
  /** 맞췄지만 accountId 가 없어 글자로 남을 이름들. 화면이 알려 주는 데 쓴다. */
  readonly unlinked: readonly string[];
}

interface Candidate {
  readonly needle: string;
  readonly label: string;
  readonly accountId: string;
}

/**
 * 맞출 후보 목록. 이름과 아이디를 모두 받고, **긴 것부터** 본다.
 *
 * 긴 이름을 먼저 보지 않으면 `@안용식` 에서 `@안` 이 먼저 맞아 뒤의 "용식" 이 글자로
 * 남는다 — 이름이 쪼개진다.
 *
 * accountId 가 없는 사람도 후보에 넣는다. 글자를 그대로 두되 "멘션이 안 됐다" 를
 * 부르는 쪽이 알 수 있어야 한다.
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

/**
 * 한 줄을 조각으로 가른다.
 *
 * `@` 가 이름과 맞지 않으면 **그대로 글자로 둔다.** 이메일 주소(`a@b.com`)처럼 `@`
 * 앞에 글자가 붙어 있는 경우도 건드리지 않는다 — 그건 멘션이 아니다.
 */
export function mentionSpans(
  text: string,
  people: readonly MentionablePerson[],
): MentionSplit {
  const candidates = candidatesOf(people);
  const spans: MentionSpan[] = [];
  const unlinked: string[] = [];
  let buffer = "";

  const flush = (): void => {
    if (buffer !== "") {
      spans.push({ kind: "text", text: buffer });
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
    spans.push({ kind: "mention", label: hit.label, accountId: hit.accountId });
    if (hit.accountId === "" && !unlinked.includes(hit.label)) unlinked.push(hit.label);
    i += 1 + hit.needle.length;
  }

  flush();
  return { spans, unlinked };
}

/**
 * 여러 줄 글을 문단으로 가른다. 빈 줄이 문단을 나눈다.
 *
 * lib/adf.ts 의 adfLines 와 같은 규칙이다 — 본문이 Jira 와 화면에서 다르게 끊기면
 * 안 되므로 그 규칙도 한 자리에 둔다.
 */
export function textBlocks(text: string): string[][] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== "")
    .map((block) => block.split("\n"));
}
