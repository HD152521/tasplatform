/**
 * 풀어 쓴 결과를 **받아 보고 판단한다** — 순수 함수.
 *
 * ## 왜 필요한가
 *
 * 프롬프트로만 막으면 또 샌다. 간단히 올리기가 한국어 한 줄을 그대로 영문 본문 자리에
 * 실어 보낸 것이 바로 그 사고였다(lib/srDraftPrompt.ts 의 QUICK_SYSTEM_PROMPT 머리말).
 * 그 글은 화면에서 **그럴듯해 보인다** — 제목도 제품도 다 채워져 있고, 본문만 읽을 수
 * 없다. 사람이 눌러 올리고 나서야 드러난다.
 *
 * ## 무엇을 보나
 *
 * 두 가지다. **한국어가 남았나**(영문으로 안 옮겼다), **메모 수준으로 짧나**(풀어 쓰지
 * 않았다). 둘 다 이 기능이 실제로 실패한 모양이다.
 *
 * ## 판정을 어디까지 쓰나
 *
 * **다시 한 번 부를 근거**로만 쓴다. 등록을 막지 않는다 — 두 번째도 마음에 안 들면 그중
 * 나은 쪽을 주고 화면에 그렇다고 적는다. 판정이 틀렸을 때(한국어 에러 문구를 그대로
 * 옮긴 짧은 글 등) 사람의 손을 묶지 않는 쪽이 낫다.
 */

/** 한글 음절과 호환 자모. 한국어가 남았는지 보는 데 쓴다. */
const HANGUL_RE = /[\u3131-\u318E\uAC00-\uD7A3]/g;

/** 영문 글자. 비율의 분모로 쓴다 — 전체 길이로 재면 숫자·기호에 흔들린다. */
const LATIN_RE = /[A-Za-z]/g;

/** 영문 낱말. 숫자나 경로만 늘어선 줄을 낱말로 세지 않는다. */
const WORD_RE = /[A-Za-z][A-Za-z0-9'’./_-]*/g;

/**
 * 이 비율을 넘으면 "영문으로 안 옮겼다" 고 본다.
 *
 * 0 이 아닌 이유: 에러 문구·로그는 **한국어여도 그대로 옮기라고** 지시한다. 한국어
 * 메시지 한 줄이 인용된 영문 본문을 실패로 보면, 지시를 지킨 글을 버린다.
 */
export const MAX_HANGUL_RATIO = 0.15;

/**
 * 본문에 이보다 영문 낱말이 적으면 "풀어 쓰지 않았다" 고 본다.
 *
 * 인사말·맺음말·Questions 머리말이 이미 다섯 낱말쯤을 쓴다. 환경 한 문단, 증상 한
 * 문단, 질문 하나면 자연히 예순은 넘는다 — 실제로 문제가 된 글은 전체가 스물다섯
 * 낱말이었다.
 */
export const MIN_CONTENT_WORDS = 60;

/** 무엇이 모자랐나. 다시 부를 때 그것만 집어 말해 준다. */
export type Shortfall = "korean" | "thin";

function countOf(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

/** 한글 대 (한글+영문) 비율. 둘 다 없으면 0. */
export function hangulRatio(text: string): number {
  const hangul = countOf(text, HANGUL_RE);
  const latin = countOf(text, LATIN_RE);
  const total = hangul + latin;
  return total === 0 ? 0 : hangul / total;
}

/** 영문 낱말 수. */
export function wordCount(text: string): number {
  return countOf(text, WORD_RE);
}

/** 모자란 것들. 비어 있으면 그대로 쓴다. */
export function draftShortfalls(content: string): Shortfall[] {
  const text = content.trim();
  if (text === "") return [];
  const out: Shortfall[] = [];
  if (hangulRatio(text) > MAX_HANGUL_RATIO) out.push("korean");
  if (wordCount(text) < MIN_CONTENT_WORDS) out.push("thin");
  return out;
}

/**
 * 두 결과 중 어느 쪽을 쓸지 고르는 **벌점.** 낮은 쪽이 낫다.
 *
 * 비어 있는 것은 모자란 것보다 나쁘다 — 제목이나 본문이 비면 등록 자체가 막힌다.
 * 그래서 어떤 모자람보다 큰 값을 준다.
 */
export function draftPenalty(draft: { subject: string; content: string }): number {
  if (draft.content.trim() === "" || draft.subject.trim() === "") return 99;
  return draftShortfalls(draft.content).length;
}

/**
 * 다시 부를 때 사용자 메시지 뒤에 덧붙이는 지시.
 *
 * 처음 프롬프트를 되풀이하지 않는다. **무엇이 틀렸는지만** 집어 말한다 — 같은 말을
 * 두 번 쌓으면 모델이 어느 쪽을 지킬지 흔들린다.
 */
export function shortfallNote(shortfalls: readonly Shortfall[]): string {
  if (shortfalls.length === 0) return "";
  const lines = ["[다시 씁니다 — 방금 결과에 아래 문제가 있었습니다]"];
  if (shortfalls.includes("korean")) {
    lines.push(
      "- 본문에 한국어가 그대로 남았습니다. **[CONTENT] 는 영어로만 씁니다.**",
      "  에러 문구·로그·명령어·경로만 원문 그대로 두고, 나머지는 모두 영어 문장으로 세웁니다.",
    );
  }
  if (shortfalls.includes("thin")) {
    lines.push(
      "- 본문이 메모 수준으로 짧습니다. 환경(Product · Component · 버전), 무엇을 하다가",
      "  무엇이 보였는지, 무엇을 확인받고 싶은지를 **완전한 문장으로** 풀어 쓰세요.",
      "  원문에 없는 사실은 그래도 만들지 않습니다.",
    );
  }
  lines.push("다섯 덩어리를 같은 순서로 다시 출력하세요.");
  return lines.join("\n");
}

/**
 * 끝까지 남은 모자람을 **화면에 적을 한 줄**로 바꾼다.
 *
 * ## 왜 한국어만 말하나
 *
 * `thin` 은 다시 부를 근거로만 쓰고 화면에는 올리지 않는다. 물어볼 것이 정말 한 줄인
 * SR 도 있다("EOL 날짜 알려주세요") — 두 번 불러도 짧은 것은 대개 더 쓸 말이 없기
 * 때문이고, 그걸 매번 경고로 띄우면 **맞게 쓴 글에도 경고가 뜬다.** 그러면 사람은
 * 경고를 읽지 않게 되고, 정작 한국어가 남은 날에도 지나친다.
 *
 * 한국어가 남은 것은 다르다. 그 글은 받는 쪽이 읽을 수 없고, 화면에서는 멀쩡해 보인다.
 * 그건 사람이 올리기 전에 보고 있어야 한다.
 */
export function shortfallWarning(shortfalls: readonly Shortfall[]): string {
  if (!shortfalls.includes("korean")) return "";
  return "본문에 한국어가 남아 있습니다 — 영문으로 다 옮겨지지 않았습니다."
    + " 올리기 전에 본문을 확인하세요.";
}
