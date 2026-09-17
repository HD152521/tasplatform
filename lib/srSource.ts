/**
 * LLM 에 넣기 전 SR 원문을 줄인다.
 *
 * 사내 Gemma 엔드포인트는 출력이 512 토큰으로 묶여 있고 입력도 넉넉하지 않다.
 * 원문에서 확실히 버려도 되는 것만 골라 걷어낸다 — 판단이 필요한 축약은 하지
 * 않는다. 그건 모델이 할 일이고, 여기서 잘못 버리면 근거가 사라진다.
 *
 * 걷어내는 것은 두 가지다.
 *   1) 같은 화자가 같은 본문을 몇 초 간격으로 두 번 올린 것 (포털에 실제로
 *      두 건으로 존재한다. thread_id 가 서로 다르므로 수집 단계에서는 정상이다.)
 *   2) 답변 끝의 서명 블록 — 맺음말 + 담당자 연락처 + 설문 안내.
 *
 * DB 행을 지우지 않는다. 같은 본문이라도 body_html 은 서로 다를 수 있어
 * (실측 70 그룹 중 66 그룹) 화면·첨부가 그쪽을 본다. 줄이는 것은 LLM 입력뿐이다.
 *
 * server-only 를 붙이지 않는다. 수집기(Node)와 테스트에서도 부른다.
 */

/**
 * 중복으로 볼 시간 간격. 실측 중앙값은 20초였고 최대는 42일이었다.
 * 42일짜리는 같은 문구를 다시 보낸 정상 재발송이므로 남겨야 한다.
 */
export const DUP_WINDOW_MS = 5 * 60 * 1000;

export interface DedupableThread {
  /** 1 = 우리가 쓴 글. 화자가 다르면 본문이 같아도 다른 사건이다. */
  isOurs: boolean;
  /** epoch ms. 없으면 시간창을 적용할 수 없어 중복으로 보지 않는다. */
  atMs?: number;
  body: string;
}

/** 공백을 무시한 본문 지문. 줄바꿈만 다른 두 건을 같게 본다. */
function bodyKey(body: string): string {
  return body.replace(/\s+/g, "");
}

/**
 * 같은 화자가 같은 본문을 짧은 간격으로 거듭 올린 것을 걷어낸다.
 *
 * 먼저 온 것을 남긴다 — 뒤엣것을 남기면 그 뒤에 이어지는 답변과의 시간 순서가
 * 어긋나 보인다. 시각이 없는 건은 손대지 않는다(판단 근거가 없으므로).
 */
export function dedupeThreads<T extends DedupableThread>(
  threads: readonly T[],
  windowMs: number = DUP_WINDOW_MS,
): T[] {
  const kept: T[] = [];
  /** (화자|본문) -> 마지막으로 남긴 시각 */
  const lastSeen = new Map<string, number>();

  for (const thread of threads) {
    const at = thread.atMs;
    if (at === undefined || Number.isNaN(at)) {
      kept.push(thread);
      continue;
    }
    const key = `${thread.isOurs ? 1 : 0}|${bodyKey(thread.body)}`;
    const previous = lastSeen.get(key);
    if (previous !== undefined && at - previous <= windowMs) continue;
    lastSeen.set(key, at);
    kept.push(thread);
  }
  return kept;
}

/** 맺음말 한 줄. 이 뒤가 연락처뿐이면 거기서부터 잘라낸다. */
const SIGNOFF = /^(best|best regards|kind regards|warm regards|regards|thanks|thank you|sincerely|cheers)[,.!]?$/i;

/** 서명 블록임을 알려 주는 표지. 이메일 주소, 회사 도메인, 직함 줄. */
const CONTACT_MARKER = [
  /[\w.+-]+@[\w-]+\.[\w.-]+/,
  /\bbroadcom\.com\b/i,
  /\bvmware by broadcom\b/i,
  /\btanzu support\b/i,
  /\bsupport engineer\b/i,
];

/**
 * 서명 뒤에 붙는 안내 문단. 내용이 없고 답변마다 그대로 반복된다.
 * 줄 전체가 아니라 "이 문구로 시작하는 문단 끝까지"를 버린다.
 */
const FOOTER_OPENER = [
  /^as part of our commitment\b/i,
  /^if you wish to\b/i,
  /^this (e-?mail|message) (and any attachments )?(is|are) (intended|confidential)\b/i,
];

/** 서명 표지가 하나라도 있는가. */
function looksLikeContact(lines: readonly string[]): boolean {
  return lines.some((line) => CONTACT_MARKER.some((pattern) => pattern.test(line)));
}

/**
 * 답변 끝의 서명 블록과 반복 안내 문단을 잘라낸다.
 *
 * 본문 한가운데의 "Thanks," 로 뒷부분을 통째로 버리면 요점을 잃는다. 그래서
 * 맺음말 뒤에 남은 줄이 전부 연락처성일 때에만 자른다. 판단이 서지 않으면
 * 원문을 그대로 둔다 — 덜 자르는 쪽이 안전하다.
 */
export function stripSignatureBlock(text: string): string {
  const lines = text.split("\n");

  // 뒤에서부터 훑어 가장 앞선 서명 시작점을 찾는다.
  let cutAt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!SIGNOFF.test((lines[i] ?? "").trim())) continue;
    const rest = lines.slice(i + 1).filter((line) => line.trim() !== "");
    // 맺음말이 마지막 줄이거나, 뒤에 연락처만 남았을 때에만 서명으로 본다.
    if (rest.length === 0 || looksLikeContact(rest)) cutAt = i;
  }
  const body = cutAt === -1 ? lines : lines.slice(0, cutAt);

  // 서명을 못 찾았어도 안내 문단은 따로 걷어낸다(맺음말 없이 붙는 경우가 있다).
  const kept: string[] = [];
  let skipping = false;
  for (const line of body) {
    const trimmed = line.trim();
    if (trimmed === "") {
      skipping = false;
      kept.push(line);
      continue;
    }
    if (FOOTER_OPENER.some((pattern) => pattern.test(trimmed))) {
      skipping = true;
      continue;
    }
    if (skipping) continue;
    kept.push(line);
  }

  return kept.join("\n").trim();
}

/** 스레드 본문을 LLM 입력용으로 줄인다. 지금은 서명 절단뿐이다. */
export function condenseBody(text: string): string {
  const condensed = stripSignatureBlock(text);
  // 전부 서명이었다면 잘못 자른 것이다. 원문을 돌려준다.
  return condensed === "" ? text.trim() : condensed;
}
