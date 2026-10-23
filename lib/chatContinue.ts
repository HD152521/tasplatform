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

/** 다시 쓴 것인지 판단할 때 비교하는 머리 길이(정규화 후 글자 수). */
const RESTART_HEAD = 60;

/**
 * 다시 쓴 것으로 보려면 머리가 이만큼은 있어야 한다(정규화 후 글자 수).
 *
 * 짧은 글에는 판정하지 않는다 — 두세 낱말은 우연히 닮는다. `첫 문장입니다` 와
 * `둘째 문장입니다` 는 앞 여섯 글자만 보면 닮음이 0.75 로 나온다. 둘은 이어 쓴
 * 조각이지 다시 쓴 것이 아니다.
 */
const MIN_RESTART_HEAD = 12;

/**
 * 다시 쓴 것으로 볼 머리 닮음 정도(0~1).
 *
 * **글자가 똑같은지로 보면 놓친다.** 모델은 다시 쓸 때 **조금씩 고쳐 쓴다** —
 * 실측으로 `원인이 … 고갈로 확인되었으며` 가 다음 회차에 `원인으로 … 고갈이
 * 확인되었으며` 로 왔다. 조사 하나가 달라 머리 비교가 어긋났고, 이어 쓴 것으로 보고
 * 그대로 붙여서 **같은 단락이 세 번 들어간 문서가 나갔다.** 그래서 닮음 정도로 본다.
 *
 * 0.65 로 둔다. 진짜 이어 쓴 조각의 머리는 글 중간 내용이라 앞 글의 머리와 거의 안
 * 닮는다(실측 0.3 아래). 고쳐 쓴 경우는 낱말이 대부분 그대로라 0.8 을 넘는다. 사이가
 * 넓어서 경계를 어디에 두어도 되지만, 놓치는 쪽(중복)이 사람 눈에 먼저 띄므로 낮게 둔다.
 */
const RESTART_SIMILARITY = 0.65;

/** 비교용으로 글자만 남긴다. 공백·기호·대소문자 차이로 닮음이 흔들리지 않게. */
function normalizeForCompare(text: string): string {
  return text.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

/**
 * 두 글의 닮음 정도(Dice, 글자 2-gram). 0~1.
 *
 * 2-gram 으로 보는 이유는 한국어에 낱말 경계가 또렷하지 않아서다. 공백으로 자르면
 * 조사가 붙은 낱말이 전부 다른 것으로 세어져 고쳐 쓴 글을 못 알아본다.
 */
function headSimilarity(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let i = 0; i + 1 < a.length; i += 1) {
    const gram = a.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i + 1 < b.length; i += 1) {
    const gram = b.slice(i, i + 2);
    const left = counts.get(gram) ?? 0;
    if (left > 0) {
      counts.set(gram, left - 1);
      shared += 1;
    }
  }
  return (2 * shared) / ((a.length - 1) + (b.length - 1));
}

/**
 * 되풀이로 볼 닮음 정도. 머리끼리 비교할 때보다 높게 둔다.
 *
 * 글 **안쪽**을 훑는 비교라 창이 많아 우연히 맞을 기회도 많다. 그리고 틀리면 받은
 * 조각을 통째로 버리므로, 머리 판정보다 조심해야 한다.
 */
const REEMIT_SIMILARITY = 0.8;

/**
 * 되풀이로 보려면 다시 쓰기 시작한 자리가 글 끝에서 이만큼은 떨어져 있어야 한다
 * (정규화 후 글자 수).
 *
 * 끝 근처가 닮은 것은 **정상이다** — 모델은 이어 쓰기 전에 직전 문장을 되짚는다.
 * 그걸 되풀이로 보고 조각을 버리면 멀쩡한 내용이 사라진다. 꼬리를 똑같이 되풀이한
 * 경우는 앞의 겹침 비교가 이미 처리하므로, 여기서는 **표현을 바꿔 되짚은** 경우만
 * 남는다. 실측에서 되풀이가 시작된 자리는 끝에서 200자쯤 떨어져 있었다. 120 자를
 * 경계로 둔다.
 */
const MIN_REEMIT_GAP = 120;

/**
 * 이어 쓴 것이 아니라 **처음부터 다시 쓴** 응답인가.
 *
 * 붙이면 같은 글이 두 번 나오므로, 이걸 놓치면 문서가 눈에 보이게 망가진다.
 * 호출부는 이 판정이 참이면 **더 이어받지 않는다** — 지시를 안 듣는 중이라 더 불러도
 * 같은 일이 반복된다.
 */
export function looksLikeRestart(soFar: string, chunk: string): boolean {
  const left = normalizeForCompare(soFar);
  const right = normalizeForCompare(chunk);

  /*
   * **길이를 양쪽 중 짧은 쪽에 맞춘다.** 다시 쓴 조각이 앞 글보다 짧을 수 있다 —
   * 상한에 더 일찍 걸린 회차다. 긴 쪽 머리를 통째로 비교하면 길이 차이 때문에 닮음이
   * 떨어져 그 경우를 놓친다.
   */
  const head = Math.min(RESTART_HEAD, left.length, right.length);
  if (head < MIN_RESTART_HEAD) return false;
  return headSimilarity(left.slice(0, head), right.slice(0, head)) >= RESTART_SIMILARITY;
}

/**
 * 처음이 아니라 **이미 쓴 글 중간부터** 다시 쓰기 시작했는가.
 *
 * 실측: `문제` 섹션이 `발생 현상 → 상세 내용 → 운영 환경 → 진단 내역` 까지 쓰다
 * 끊겼는데, 이어받은 조각이 `진단 내역:` 부터 다시 시작했다. 머리끼리 비교하는
 * `looksLikeRestart` 는 앞 글의 머리가 `발생 현상` 이라 이것을 못 잡는다. 그래서
 * 조각의 머리가 앞 글 **안쪽 어딘가**와 닮는지도 본다.
 *
 * 되풀이면 조각을 버리고 앞 글을 지킨다 — 앞 글에 이미 그 내용이 있고, 조각은 그것을
 * 다시 쓴 것이다.
 */
export function looksLikeReemission(soFar: string, chunk: string): boolean {
  const whole = normalizeForCompare(soFar);
  const head = normalizeForCompare(chunk).slice(0, RESTART_HEAD);
  if (head.length < MIN_RESTART_HEAD) return false;

  /*
   * 끝에서 MIN_REEMIT_GAP 자 안에서 시작하는 닮음은 보지 않는다 — 꼬리를 되짚은
   * 것이다. 창을 채울 길이(head.length)도 남아 있어야 한다.
   */
  const lastStart = whole.length - Math.max(head.length, MIN_REEMIT_GAP);
  for (let i = 0; i <= lastStart; i += 1) {
    if (headSimilarity(whole.slice(i, i + head.length), head) >= REEMIT_SIMILARITY) return true;
  }
  return false;
}

/**
 * 이어받은 조각을 앞 글에 붙인다.
 *
 * 공백을 끼워 넣지 않는다 — 끊긴 자리가 낱말 중간일 수 있다(`systemc` + `tl restart`).
 * 조각이 공백으로 시작하면 그 공백은 그대로 둔다.
 *
 * 판정 순서가 중요하다. **겹침 비교를 되풀이 검사보다 먼저** 한다 — 꼬리를 그대로
 * 되짚고 이어 쓴 조각은 정상이고, 그걸 되풀이로 보면 멀쩡한 내용을 버린다.
 */
export function stitchContinuation(soFar: string, chunk: string): string {
  if (chunk.trim() === "") return soFar;
  if (soFar === "") return chunk;

  // 1) 처음부터 다시 쓴 응답. 긴 쪽을 택한다 — 붙이면 같은 글이 두 번 나온다.
  if (looksLikeRestart(soFar, chunk)) return chunk.length >= soFar.length ? chunk : soFar;

  // 2) 꼬리를 되짚고 이어 쓴 조각. 겹친 만큼 떼고 붙인다.
  const limit = Math.min(MAX_OVERLAP, soFar.length, chunk.length);
  for (let n = limit; n >= MIN_OVERLAP; n -= 1) {
    if (chunk.startsWith(soFar.slice(-n))) return soFar + chunk.slice(n);
  }

  // 3) 글 중간부터 다시 쓴 조각. 앞 글에 이미 있는 내용이므로 조각을 버린다.
  if (looksLikeReemission(soFar, chunk)) return soFar;

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
  return `아래는 **이미 작성이 끝난 글의 뒷부분을 채우는 작업**이다. 새 글을 쓰는 것이 아니다.

=== 원래 지시(참고용. 다시 답하지 말 것) ===
${originalUser}

=== 이미 쓴 글의 끝부분 ===
${tail}

위 글이 출력 상한에 걸려 **중간에서 끊겼다.** 네 답의 **첫 글자**가 끊긴 자리의 다음
글자여야 한다.

지켜야 할 것:
- 처음부터 다시 쓰지 말 것. 고쳐 쓰거나 바꿔 쓰는 것도 다시 쓰는 것이다.
- 이미 쓴 문장을 한 번이라도 되풀이하지 말 것. 표현을 바꿔 되풀이하는 것도 안 된다.
- 머리말·제목·요약·인사말을 새로 붙이지 말 것.
- 끊긴 문장이 있으면 그 문장의 남은 부분부터 이어서 끝낼 것.
- 이미 쓴 내용은 **참고만** 할 것. 그대로 가져다 쓰지 말 것.`;
}

/**
 * 이어받기 최대 횟수.
 *
 * **실제로 멈추는 쪽은 이 숫자가 아니라 마감이다**(`deadlineMs`). 이 숫자는 마감이
 * 없는 호출부를 위한 안전장치다 — 끝이 안 나는 글을 무한히 부르지 않게 한다.
 *
 * 한때 2였다. 그러면 출력 상한이 작을 때(기본 512 토큰) 세 번 불러도 모자란 섹션이
 * 중간에서 끝났고, 상한을 올리지 않으면 고쳐지지 않았다. 설정을 바꿔야 완성되는 기능은
 * 완성되는 기능이 아니다. 그래서 횟수를 넉넉히 두고 시간으로 끊는다 — 512 토큰이면
 * 여덟 번에 4천 토큰 가까이 되고, 섹션 몫 60초 안에서 호출이 빠를 때만 거기까지 간다.
 */
export const MAX_CONTINUATIONS = 8;

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

    /*
     * **다시 써 온 경우는 여기서 끝낸다**(처음부터든, 글 중간부터든).
     *
     * 더 불러도 같은 일이 반복된다 — 지시를 안 듣는 중이고, 횟수만큼 같은 단락이
     * 쌓인다(실측: 세 번 부르고 같은 단락이 세 번 들어간 문서가 나갔다). 긴 쪽을
     * 남기고 멈추되 `truncated` 는 그대로 둔다 — 끝까지 못 쓴 것은 사실이고, 그 사실이
     * 로그에 남아야 상한을 올릴 판단을 할 수 있다.
     */
    const repeated = looksLikeRestart(text, next.text) || looksLikeReemission(text, next.text);
    text = stitchContinuation(text, next.text);
    truncated = next.truncated;
    if (repeated) return { text, truncated: true, calls };
  }

  return { text, truncated, calls };
}
