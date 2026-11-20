/**
 * `@`·`#` 자동완성의 **판정과 목록** — 순수 함수만.
 *
 * ## 왜 화면에서 떼어 냈나
 *
 * 처음에는 이 함수들이 `app/calendar/TokenInput.tsx` 안에 있었다. 그런데 `.tsx` 는
 * node 가 타입을 벗기지 못해(`ERR_UNKNOWN_FILE_EXTENSION`) `node --test` 로 불러올
 * 수 없다. 판정이 틀리면 조용히 망가지는 종류라 — 떠야 할 때 안 뜨면 사람이 외워
 * 적고, 틀린 태그는 "성격" 으로 떨어져 Jira 제목의 대괄호가 빈다 — 시험으로 잠글
 * 수 있는 자리에 둔다.
 */
import { CORPS, SCOPES } from "./jiraHouseStyle.ts";

export type Trigger = "@" | "#";

export interface Suggestion {
  /** 넣을 글자(`@`·`#` 뒤에 붙는 것). */
  readonly insert: string;
  /** 목록에 보일 이름. */
  readonly label: string;
  /** 오른쪽에 흐리게 붙는 설명. 그 값이 Jira 의 **어디로 가는지** 적는다. */
  readonly hint: string;
  /** 왼쪽 묶음 이름. */
  readonly group: string;
}

export interface ActiveToken {
  readonly trigger: Trigger;
  readonly query: string;
  /** `@`·`#` 가 있는 자리. 고른 값으로 갈아 끼울 때 쓴다. */
  readonly start: number;
}

/** 자주 쓰는 업무 성격. app/calendar/EventForm.tsx 의 칩과 같은 목록이다. */
export const WORK_KINDS = ["점검", "작업", "장애", "회의", "교육", "휴가"] as const;

/**
 * 지금 커서가 **어떤 토큰을 적는 중인지** 읽는다.
 *
 * 커서 앞쪽만 본다 — 가운데를 고치는 중에도 지금 적는 토큰이 기준이다.
 * `@`·`#` 가 낱말 맨 앞에 있어야 토큰이다. `a@b.com` 의 `@` 는 토큰이 아니다
 * (이메일 주소를 적는 사람에게 팀원 목록이 뜨면 방해만 된다).
 * 공백·줄바꿈을 만나면 그 토큰은 끝난 것이다.
 */
export function activeToken(
  text: string,
  caret: number,
  triggers: readonly Trigger[],
): ActiveToken | null {
  const head = text.slice(0, caret);
  for (let i = head.length - 1; i >= 0; i -= 1) {
    const ch = head[i] as string;
    if (/\s/.test(ch)) return null;
    if (ch === "@" || ch === "#") {
      if (!triggers.includes(ch)) return null;
      const before = i === 0 ? "" : (head[i - 1] as string);
      if (before !== "" && !/\s/.test(before)) return null;
      return { trigger: ch, query: head.slice(i + 1), start: i };
    }
  }
  return null;
}

/**
 * `#` 목록. 각 값이 Jira 의 어디로 가는지 설명에 적는다 — 그게 이 목록의 절반이다.
 * 법인은 사용자가 쓰는 줄임말(은·중·본)을 함께 보여 준다.
 */
export function tagSuggestions(): Suggestion[] {
  return [
    ...SCOPES.map((s) => ({ insert: s, label: s, hint: "제목 앞 대괄호", group: "전산망" })),
    ...CORPS.map((c) => ({
      insert: c,
      label: c,
      hint: `상위 에픽 · ${c === "은행" ? "은" : c === "중앙회" ? "중" : "본"} 으로도 됩니다`,
      group: "법인",
    })),
    ...WORK_KINDS.map((k) => ({
      insert: k,
      label: k,
      hint:
        k === "장애"
          ? "라벨 TAS_장애대응"
          : k === "회의" || k === "교육"
            ? "라벨 TAS_내부업무"
            : "라벨 TAS_작업지원",
      group: "성격",
    })),
  ];
}

export interface SuggestablePerson {
  readonly userId: number;
  readonly displayName: string;
  readonly loginId: string;
  readonly hasJira: boolean;
}

/**
 * `@` 목록.
 *
 * **Jira 가 연결되지 않은 사람도 보여 준다.** 빼면 "왜 저 사람은 안 나오지" 가 되고,
 * 적어 두면 담당자 칸이 비는 대신 본문에 이름이 남는다. 그 사실을 설명에 적는다.
 */
export function memberSuggestions(people: readonly SuggestablePerson[]): Suggestion[] {
  return people.map((m) => {
    const label = m.displayName === "" ? m.loginId : m.displayName;
    return {
      insert: label,
      label,
      hint: m.hasJira ? m.loginId : `${m.loginId} · Jira 미연결`,
      group: "팀원",
    };
  });
}

/**
 * 적고 있는 글자로 좁힌다. 비면 **전부** 돌려준다 — `#` 만 쳤을 때 목록이 떠야 한다.
 *
 * 앞글자가 맞는 것을 먼저 보여 주고, 하나도 없을 때만 가운데 글자까지 본다.
 * 그래야 `운` 을 쳤을 때 "운영" 이 맨 위에 온다.
 */
export function filterSuggestions(all: readonly Suggestion[], query: string): Suggestion[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...all];
  const starts = all.filter(
    (s) => s.insert.toLowerCase().startsWith(q) || s.hint.toLowerCase().startsWith(q),
  );
  if (starts.length > 0) return starts;
  return all.filter(
    (s) => s.insert.toLowerCase().includes(q) || s.hint.toLowerCase().includes(q),
  );
}

/**
 * 고른 값을 글 안에 끼워 넣는다. 넣은 뒤 커서가 갈 자리도 함께 돌려준다.
 *
 * 뒤에 바로 글자가 붙어 있으면 공백을 넣지 않는다 — 가운데를 고치는 경우다.
 */
export function applySuggestion(
  text: string,
  token: ActiveToken,
  caret: number,
  insert: string,
): { text: string; caret: number } {
  const before = text.slice(0, token.start);
  const after = text.slice(caret);
  const gap = after.startsWith(" ") || after === "" ? "" : " ";
  const inserted = `${token.trigger}${insert}`;
  return {
    text: `${before}${inserted}${gap}${after}`,
    caret: before.length + inserted.length + gap.length,
  };
}
