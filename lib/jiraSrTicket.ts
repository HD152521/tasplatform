/**
 * SR 하나에 대응하는 Jira 티켓의 **제목과 본문**을 만든다 — 순수 함수.
 *
 * 보내는 일은 lib/jiraWrite.ts 가 한다. 여기서 모양만 정하는 이유는, 모양이 틀리면
 * 티켓 수십 개를 손으로 고쳐야 하는데 그 판정을 시험으로 잠글 수 있기 때문이다.
 *
 * ## 제목
 *
 *     [운영] <한글 제목> 진행
 *     [개발] <한글 제목> 진행
 *
 * 대괄호는 **운영/개발 둘뿐**이고 모르면 `운영` 이다. 기존 티켓도 이 꼴이다.
 * 고객사(은행)는 제목이 아니라 상위 항목(에픽)으로 가른다.
 *
 * ## 왜 한글이어야 하나
 *
 * 티켓은 **우리 팀이 읽는다.** 포털에 올라가는 SR 제목은 영문이지만(한국어로 적으면
 * 번역해서 올린다), 그 영문을 티켓 제목으로 쓰면 목록에서 무슨 일인지 읽히지 않는다.
 * 그래서 번역 **전** 한글을 받아 쓴다. 한글이 없으면(영문으로 바로 쓴 경우) 영문으로
 * 떨어진다 — 제목이 비는 것보다 낫다.
 *
 * ## 본문
 *
 * AI 를 쓰지 않는다. 등록은 사람이 앞에서 기다리는 구간이고 요약 호출은 7~8초다.
 * 티켓은 추적용이라 원문 앞머리로 충분하고, 자세한 내용은 SR 이 끝난 뒤 Confluence
 * 링크를 댓글로 남겨 채운다.
 */
import { adfDoc, adfHeading, adfLines, adfLink, adfParagraph, type AdfDoc } from "./adf.ts";

/** 운영이냐 개발이냐. 모르면 운영이다. */
export type SrTrack = "운영" | "개발";

export const DEFAULT_TRACK: SrTrack = "운영";

/**
 * 한글이 들어 있는 글인가.
 *
 * 번역 버튼을 두 번 누르면 두 번째에는 입력칸에 **영문**이 들어 있다. 그걸 "한글 원문"
 * 으로 붙잡으면 티켓 본문이 영문으로 떨어진다 — 티켓을 한글로 쓰려는 이유가 사라진다.
 * 그래서 붙잡기 전에 한글인지 본다.
 */
export function hasHangul(text: string): boolean {
  return /[가-힣ᄀ-ᇿ㄰-㆏]/.test(text);
}

/** 제목이 너무 길면 Jira 가 거부한다(255자). 넉넉히 가둔다. */
const SUMMARY_LIMIT = 240;

/** 본문에 실을 원문 길이. 티켓은 추적용이라 앞머리로 충분하다. */
const BODY_CHARS = 700;

/**
 * 글자 수로 자르되 **서러게이트 쌍을 쪼개지 않는다.**
 *
 * 이모지는 두 칸을 차지한다. 경계가 그 사이에 걸리면 외톨이 서러게이트가 JSON 으로
 * 나가고 Jira 가 400 으로 거절한다 — 곁가지 칸을 떼고 다시 보내도 같은 400 이라
 * 티켓이 아예 안 만들어진다.
 */
function cutSafely(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  // 하이 서러게이트로 끝났으면 짝을 잃은 것이다. 한 칸 줄인다.
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * 글에서 운영/개발을 **미리 골라** 준다. 확정이 아니라 기본값 제안이다.
 *
 * 글만 보고 맞히려 들지 않는다 — 화면에서 사람이 고치게 두고, 여기서는 분명한 말이
 * 있을 때만 `개발` 로 기운다. 틀린 구분으로 티켓이 올라가는 것보다 사람이 한 번 보는
 * 편이 낫다.
 */
export function guessTrack(text: string): SrTrack {
  // "개발계", "개발 환경", "dev", "스테이징", "검증계" 처럼 환경을 가리키는 말만 본다.
  // "개발자" 는 사람을 가리키므로 세지 않는다(그 글자 때문에 운영 건이 개발로 갔다).
  const hit = /개발\s*(계|환경|서버|클러스터)|스테이징|검증\s*계|\bstaging\b|\bdev\b/i.test(text);
  return hit ? "개발" : DEFAULT_TRACK;
}

/** 아는 구분만 받는다. 모르는 값이 오면 기본값. */
export function readTrack(value: unknown): SrTrack {
  return value === "개발" ? "개발" : DEFAULT_TRACK;
}

/** 제목으로 쓸 길이. 너무 길면 목록에서 읽히지 않는다. */
const KO_TITLE_CHARS = 60;

/**
 * 한글 원문에서 제목을 뽑는다.
 *
 * 사람에게 제목을 따로 적게 하지 않으려는 것이다. 첫 줄이 곧 무슨 일인지인 경우가
 * 대부분이고, 아니면 화면에서 고치면 된다(뽑은 값을 입력칸에 채워 보여 준다).
 *
 * **AI 를 쓰지 않는다.** 등록은 사람이 앞에서 기다리는 구간이고, 제목 한 줄에 7~8초를
 * 쓸 이유가 없다.
 */
export function koTitleFrom(text: string): string {
  const firstLine = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]\s*|#{1,6}\s*)+/, "").trim())
    .find((line) => line !== "") ?? "";
  if (firstLine === "") return "";

  // 한 줄이 길면 문장 끝에서 자른다. 문장 부호가 없으면 글자 수로 자른다.
  const sentence = /^(.{10,}?[.!?。？！])\s/.exec(firstLine);
  const head = sentence?.[1] ?? firstLine;
  if (head.length <= KO_TITLE_CHARS) return head.replace(/[.。]\s*$/, "");

  const cut = cutSafely(head, KO_TITLE_CHARS);
  // 낱말 중간에서 끊기면 마지막 공백까지 되돌린다(공백이 없으면 그대로 자른다).
  const space = cut.lastIndexOf(" ");
  return (space > KO_TITLE_CHARS * 0.6 ? cut.slice(0, space) : cut).trim();
}

export interface SrTicketInput {
  /** 포털 케이스 번호 표기(화면에 보이는 그 값). */
  readonly caseLabel: string;
  /** 번역 전 한글 제목. 없으면 영문으로 떨어진다. */
  readonly titleKo: string;
  /** 포털에 올라간 영문 제목. 한글이 없을 때 쓴다. */
  readonly subjectEn: string;
  readonly track: SrTrack;
  readonly productName: string;
  readonly componentName: string;
  /** 사람이 적은 한글 원문. 없으면 영문 본문. */
  readonly bodyKo: string;
  /** 포털에서 이 케이스를 여는 주소. 비어도 된다. */
  readonly caseUrl: string;
}

/**
 * 티켓 제목.
 *
 * 한글 제목이 비면 영문으로 떨어진다. 둘 다 비면 케이스 번호만 남는다 — 제목 없는
 * 티켓은 만들 수 없으므로 그 자리라도 채운다.
 */
export function srTicketSummary(input: SrTicketInput): string {
  const title = input.titleKo.trim() !== "" ? input.titleKo.trim() : input.subjectEn.trim();
  const head = `[${input.track}]`;
  const body = title === "" ? `Case ${input.caseLabel}` : `${title} 진행`;
  return cutSafely(`${head} ${body}`, SUMMARY_LIMIT).trim();
}

/**
 * 티켓 본문(ADF).
 *
 * 기존 티켓의 모양을 따른다 — `Case <번호>` 를 제목처럼 올리고, 그 아래 무슨 일인지
 * 적는다. 제품·컴포넌트와 포털 링크를 뒤에 붙여 추적할 수 있게 한다.
 */
export function srTicketBody(input: SrTicketInput): AdfDoc {
  const story = cutSafely((input.bodyKo.trim() !== "" ? input.bodyKo : "").trim(), BODY_CHARS);
  const where = [input.productName, input.componentName].filter((v) => v.trim() !== "").join(" / ");

  return adfDoc([
    adfHeading(3, `Case ${input.caseLabel}`),
    ...(story === "" ? [] : adfLines(story)),
    adfParagraph(),
    ...(where === "" ? [] : [adfParagraph(`제품/컴포넌트: ${where}`)]),
    input.caseUrl === "" ? null : adfParagraph("케이스: ", adfLink(input.caseLabel, input.caseUrl)),
  ]);
}
