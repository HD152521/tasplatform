/**
 * 잘린 답을 **이어받아 붙이기** — 순수 함수.
 *
 * 사내 엔드포인트의 출력 상한이 작다(기본 512 토큰, lib/llmConfig.ts). 한국어는 토큰이
 * 비싸서 섹션 하나가 그 상한을 넘기면 **문장 중간에서 끊긴 글이 그대로 문서가 됐다.**
 * 섹션을 쪼갠 것만으로는 모자랐다(lib/summaryPrompt.ts).
 *
 * 그래서 잘렸으면 "여기까지 썼다, 이어서 써라" 로 한 번 더 부르고 코드가 이어 붙인다.
 *
 * ## 길이로 짐작하지 않는다
 *
 * 잘렸는지는 응답이 말해 준다 — `finish_reason: "length"`. 길이로 짐작하면 상한이
 * 바뀔 때마다 틀리고, 짧고 완성된 답을 잘린 것으로 오해해 쓸데없이 한 번 더 부른다.
 *
 * ## 이어 붙일 때 겹침을 뗀다
 *
 * 모델은 자주 **직전 몇 글자를 되풀이하며** 이어 쓴다. 그대로 붙이면 같은 구절이 두 번
 * 나온다. 꼬리와 머리가 겹치면 겹친 만큼 뗀다. 아예 **처음부터 다시 쓴** 응답도 있어
 * 그건 다시 쓴 쪽을 택한다.
 */

/** 겹침을 찾을 최대 길이. 이보다 길게 되풀이하는 경우는 사실상 다시 쓴 것이다. */
const MAX_OVERLAP = 400;

/**
 * 겹침으로 인정할 최소 길이.
 *
 * 너무 짧으면 우연히 맞는다 — 마침표나 `습니다.` 같은 꼬리는 어디서나 겹친다. 그걸
 * 겹침으로 보고 떼면 **멀쩡한 글자가 사라진다.** 너무 길면 실제 되풀이를 놓친다 —
 * 모델이 되풀이하는 분량은 실측 아홉 글자(`것이다. 적용 후`)짜리도 있다. 여섯 글자를
 * 경계로 둔다. 그 길이가 우연히 맞으려면 이어 쓴 글이 **앞 글의 꼬리와 똑같이**
 * 시작해야 하는데, 그건 사실상 되풀이한 경우다.
 */
const MIN_OVERLAP = 6;

/** 다시 쓴 것인지 판단할 때 비교하는 머리 길이. */
const RESTART_HEAD = 40;

/**
 * 다시 쓴 것으로 보려면 머리가 이만큼은 같아야 한다.
 *
 * 겹침 경계보다 길게 둔다 — 이 판정이 틀리면 조각 하나를 통째로 버리거나 앞 글을
 * 통째로 버린다. 겹침을 잘못 떼는 것보다 손실이 크다.
 */
const MIN_RESTART_HEAD = 12;

/**
 * 이어받은 조각을 앞 글에 붙인다.
 *
 * 공백을 끼워 넣지 않는다 — 끊긴 자리가 낱말 중간일 수 있다(`systemc` + `tl restart`).
 * 조각이 공백으로 시작하면 그 공백은 그대로 둔다.
 */
export function stitchContinuation(soFar: string, chunk: string): string {
  if (chunk.trim() === "") return soFar;
  if (soFar === "") return chunk;

  /*
   * 처음부터 다시 쓴 응답. 긴 쪽을 택한다 — 붙이면 같은 글이 두 번 나온다.
   *
   * **둘 중 짧은 쪽 길이로 비교한다.** 다시 쓴 조각이 앞 글보다 짧을 수 있어
   * (상한에 더 일찍 걸린 회차), 앞 글의 머리 40자로만 비교하면 그 경우를 놓친다.
   */
  const headLen = Math.min(RESTART_HEAD, soFar.length, chunk.length);
  if (headLen >= MIN_RESTART_HEAD && chunk.slice(0, headLen) === soFar.slice(0, headLen)) {
    return chunk.length >= soFar.length ? chunk : soFar;
  }

  const limit = Math.min(MAX_OVERLAP, soFar.length, chunk.length);
  for (let n = limit; n >= MIN_OVERLAP; n -= 1) {
    if (chunk.startsWith(soFar.slice(-n))) return soFar + chunk.slice(n);
  }
  return soFar + chunk;
}

/**
 * 이어 쓰라는 지시.
 *
 * 앞 글 **전체**를 되돌려 보내지 않는다 — 입력이 매번 불어나 상한을 먹고, 같은 내용에
 * 두 번 돈을 쓴다. 끊긴 자리를 알려주는 데는 꼬리 몇 줄로 충분하다.
 */
export function continuationUser(originalUser: string, soFar: string, tailChars = 300): string {
  const tail = soFar.slice(-tailChars);
  return `${originalUser}

=== 지금까지 쓴 글의 끝부분 ===
${tail}

위 글이 상한에 걸려 **중간에서 끊겼다.** 끊긴 바로 다음부터 이어서 써라.
- 인사말·머리말·요약을 새로 쓰지 말 것
- 이미 쓴 내용을 되풀이하지 말 것
- 끊긴 문장이 있으면 그 문장부터 이어서 끝낼 것`;
}

/** 이어받기 최대 횟수. 한 섹션에 세 번(처음 + 두 번)까지 부른다. */
export const MAX_CONTINUATIONS = 2;

/**
 * 남은 시간이 이보다 적으면 새로 부르지 않는다.
 *
 * 2초 남기고 부르면 어차피 타임아웃으로 버려진다 — 호출만 쓰고 글은 못 받는다.
 */
export const MIN_CALL_MS = 10_000;

export interface ContinuationLimits {
  readonly maxContinuations?: number;
  /** 이 시각(epoch ms)을 넘기면 더 이어받지 않는다. 섹션 몫 안에서 돌게 하는 장치다. */
  readonly deadlineMs?: number;
  /** 한 호출의 상한. 마감이 있으면 남은 시간과 작은 쪽을 쓴다. */
  readonly timeoutMs?: number;
  readonly minCallMs?: number;
}

export interface ContinuationOutcome {
  readonly text: string;
  /** 끝까지 못 썼다. 횟수·시간 상한에 걸렸거나 이어받기가 실패했다. */
  readonly truncated: boolean;
  readonly calls: number;
  /** 이어받기 중 실패한 사유. 첫 호출 실패는 던진다(여기 담기지 않는다). */
  readonly error?: string;
}

/**
 * 잘리면 이어받아 가며 한 덩이를 완성한다.
 *
 * `call` 은 사용자 메시지와 이 호출의 타임아웃을 받아 `{ text, truncated }` 를 돌려준다.
 * 백엔드(사내 LLM / OpenAI)를 모르게 두어 이 고리를 따로 시험할 수 있다.
 *
 * ## 첫 호출 실패와 이어받기 실패를 다르게 다룬다
 *
 * 첫 호출이 실패하면 **던진다** — 빈 글을 성공으로 돌려주면 빈 문서가 게시된다.
 * 이어받기가 실패하면 **받은 만큼 돌려준다.** 앞부분은 멀쩡하고, 짧은 문서가 아무
 * 문서도 없는 것보다 낫다. 대신 사유를 담아 보내 호출부가 로그에 남긴다.
 *
 * ## 마감을 넘기지 않는다
 *
 * 요약 라우트 예산이 이미 꽉 차 있다(섹션 60초 × 5 = maxDuration 300초,
 * lib/summaryPrompt.ts). 그래서 이어받기는 **새 예산을 쓰지 않고 그 섹션 몫 안에서만**
 * 돈다. 첫 호출이 오래 걸렸으면 이어받지 않고 그대로 끝낸다.
 */
export async function runWithContinuation(
  call: (user: string, timeoutMs: number | undefined) => Promise<{ text: string; truncated: boolean }>,
  user: string,
  limits: ContinuationLimits = {},
): Promise<ContinuationOutcome> {
  const maxContinuations = limits.maxContinuations ?? MAX_CONTINUATIONS;
  const minCallMs = limits.minCallMs ?? MIN_CALL_MS;

  /** 이 호출에 줄 타임아웃. 마감이 있으면 남은 시간과 작은 쪽. 없으면 설정값. */
  const budget = (): number | undefined => {
    if (limits.deadlineMs === undefined) return limits.timeoutMs;
    // 음수를 넘기면 AbortSignal.timeout 이 터진다. 0 이면 즉시 중단되고, 그건
    // 마감이 이미 지났다는 정직한 결과다(첫 호출이면 그대로 던진다).
    const left = Math.max(limits.deadlineMs - Date.now(), 0);
    return limits.timeoutMs === undefined ? left : Math.min(limits.timeoutMs, left);
  };

  const first = await call(user, budget());
  let text = first.text;
  let truncated = first.truncated;
  let calls = 1;

  while (truncated && calls <= maxContinuations) {
    const left = budget();
    if (left !== undefined && left < minCallMs) break; // 시간이 없다. 받은 만큼 쓴다.
    let next: { text: string; truncated: boolean };
    try {
      next = await call(continuationUser(user, text), left);
    } catch (error) {
      return {
        text,
        truncated: true,
        calls,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    calls += 1;
    text = stitchContinuation(text, next.text);
    truncated = next.truncated;
  }

  return { text, truncated, calls };
}
