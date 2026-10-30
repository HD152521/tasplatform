/**
 * 해결 섹션 뒷정리 — 소제목 올리기와 참고 문서 떼어내기. 순수 함수.
 *
 * ## 무엇이 문제였나
 *
 * 실제 게시된 문서가 `조치 방안:` → `참고 공식 문서:` → `조치 효과:` 순으로 나왔다.
 * 조치와 그 효과가 링크 뭉치로 갈라져, 읽는 사람은 조치를 읽다가 URL 목록을 지나
 * 다시 효과를 만난다. 팀 양식은 **조치 → 효과**로 이어 읽고 참고 문서는 맨 끝에
 * 따로 두는 모양이다.
 *
 * 순서를 프롬프트로만 못박는 것은 믿을 수 없다 — 이미 "항목으로 씁니다" 라고만
 * 적어 두었는데도 모델이 중간에 끼워 넣었다. 그래서 **코드가** 참고 문서를 뽑아
 * 문서 맨 끝으로 옮기고(splitReferences), 조치 방안·조치 효과는 소제목으로 올려
 * (promoteSubheadings) 눈으로 갈라 보이게 한다. 프롬프트는 1차 방어선이다.
 *
 * DOM 도 네트워크도 모른다. 글자만 다룬다.
 */

/** 떼어낸 참고 문서가 갖는 섹션 제목. */
export const REFERENCE_HEADING = "참고 공식 문서";

/** 라벨 글자를 정규식 조각으로. `조치 방안` 이 `조치방안` 으로 와도 알아본다. */
function loose(label: string): string {
  return label.replace(/\s+/g, "\\s*");
}

/** `- **조치 방안:** 본문` 처럼 글머리와 강조가 붙어도 라벨 줄로 알아본다. */
function labelPattern(label: string): RegExp {
  return new RegExp(`^\\s*(?:[-•*]\\s*)*[*_]{0,2}(?:${loose(label)})[*_]{0,2}\\s*[:：]\\s*(.*)$`);
}

/** `#### 참고 공식 문서` 처럼 라벨이 아니라 제목으로 쓴 경우. */
function headingPattern(label: string): RegExp {
  return new RegExp(`^\\s*#{1,6}\\s*[*_]{0,2}(?:${loose(label)})[*_]{0,2}\\s*[:：]?\\s*$`);
}

function isFence(line: string): boolean {
  return /^\s*```/.test(line);
}

const URL_RE = /https?:\/\/\S+/g;

/**
 * 줄에서 링크만 뽑는다.
 *
 * 꼬리 문장부호는 뗀다 — `https://a 와 https://b.` 처럼 문장에 섞여 오면 마침표가
 * 링크에 붙어 눌러도 404 가 난다. 닫는 괄호는 **URL 에 들어 있을 수 있어** 떼지 않는다
 * (Confluence·MS 문서 주소에 흔하다). 짝이 맞지 않는 경우까지 보려면 괄호를 세야 하고,
 * 그건 여기서 할 일이 아니다.
 */
function urlsIn(text: string): string[] {
  return (text.match(URL_RE) ?? []).map((u) => u.replace(/[,.;'"<>]+$/, ""));
}

/** 먼저 나온 것만 남긴다. 같은 문서를 두 번 인용한 것은 링크 목록에서 군더더기다. */
function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * 참고 문서를 본문에서 떼어낸다.
 *
 * 라벨 줄에 붙어 있는 링크와, 그 아래로 이어지는 **링크가 있는 줄**을 가져온다.
 * 빈 줄은 사이에 끼어도 되고(`참고 공식 문서:` 다음 줄부터 목록인 경우), 링크가 없는
 * 줄이 나오면 거기서 멈춘다 — 뒤에 다른 이야기가 이어지는데 통째로 삼키면 본문이 사라진다.
 *
 * ## 가져갈 링크가 없으면 손대지 않는다
 *
 * `참고 공식 문서: 별도 문서 없음` 처럼 쓴 경우다. 라벨만 뽑아 맨 끝에 빈 섹션을
 * 만들면 읽는 사람에게는 **제목만 있고 아무것도 없는 칸**이 남는다. 그냥 본문에 둔다.
 * 다만 제목 꼴(`#### 참고 공식 문서`)로 쓴 빈 것은 지운다 — 그건 본문이 아니다.
 *
 * ## 라벨 줄의 설명 문구는 버린다
 *
 * `참고 공식 문서: 아래 문서를 참고했습니다 https://...` 의 앞부분이다. 링크를 빼고
 * 남은 조각은 "아래 문서를 참고했습니다" 처럼 링크 목록 제목이 이미 말해 주는 것이거나,
 * `공식 문서 와 KB` 처럼 토막난 글이 된다. 토막을 본문에 남기는 것보다 버리는 쪽이 낫다.
 */
export function splitReferences(text: string): { body: string; references: string[] } {
  const label = labelPattern(REFERENCE_HEADING);
  const heading = headingPattern(REFERENCE_HEADING);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  const refs: string[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (isFence(line)) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    // 코드 블록 안의 주소는 설정값이다. 참고 문서로 끌어내면 설정이 깨진다.
    if (inFence) {
      kept.push(line);
      continue;
    }

    const matched = line.match(label);
    if (matched === null && !heading.test(line)) {
      kept.push(line);
      continue;
    }

    const found = urlsIn(matched?.[1] ?? "");
    let last = i;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] ?? "";
      if (next.trim() === "") continue; // 빈 줄은 건너뛰되, 링크를 만나야 가져간다
      if (isFence(next)) break;
      const urls = urlsIn(next);
      if (urls.length === 0) break;
      found.push(...urls);
      last = j;
    }

    if (found.length === 0) {
      if (matched !== null) kept.push(line); // 라벨 줄은 본문으로 둔다
      continue;
    }
    refs.push(...found);
    i = last;
  }

  return { body: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), references: dedupe(refs) };
}

/** 떼어낸 링크를 섹션 본문으로. 한 줄에 하나씩 둬야 눌러 쓸 수 있다. */
export function renderReferences(references: readonly string[]): string {
  return dedupe(references).map((url) => `- ${url}`).join("\n");
}

/**
 * `라벨: 본문` 을 `#### 라벨` + 본문으로 올린다.
 *
 * 한 섹션 안에서 조치와 효과가 어디서 갈리는지 눈에 보이게 하려는 것이다. 글머리
 * 항목으로 두면 둘이 같은 목록의 형제처럼 붙어 버려, 긴 조치 설명 끝에 효과가
 * 묻힌다. 제목은 `####` 다 — 섹션 제목(`###`)보다 한 단계 아래라야 안에 든 것으로 읽힌다.
 *
 * 라벨 글자는 **넘겨받은 쪽 표기로** 다시 쓴다. 모델이 `조치방안:` 으로 붙여 써 보내도
 * 문서에는 `조치 방안` 으로 나온다.
 */
export function promoteSubheadings(text: string, labels: readonly string[]): string {
  if (labels.length === 0) return text;
  const patterns = labels.map((label) => ({ label, re: labelPattern(label) }));
  const out: string[] = [];
  let inFence = false;

  for (const line of text.split("\n")) {
    if (isFence(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    const hit = inFence ? undefined : patterns.find((p) => p.re.test(line));
    if (hit === undefined) {
      out.push(line);
      continue;
    }
    const rest = (line.match(hit.re)?.[1] ?? "").trim();
    if (out.length > 0 && out.at(-1)?.trim() !== "") out.push("");
    out.push(`#### ${hit.label}`, "");
    if (rest !== "") out.push(rest);
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
