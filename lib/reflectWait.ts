/**
 * 쓴 것이 조회에 **잡힐 때까지** 몇 번 다시 묻는다 — 순수 함수.
 *
 * ## 왜 한 번으로 끝내지 않나
 *
 * 답변을 보내거나 케이스를 만든 직후, 포털은 글을 받아 두고도 목록·스레드 조회에
 * 바로 싣지 않는 순간이 있다. 그래서 "받아서 DB 에 넣기" 를 한 번 하고 끝내면,
 * 넣었는데도 방금 쓴 글이 없는 경우를 **구분하지 못한다.** 화면은 성공이라 말하고
 * 대화는 그대로니, 담당자는 "다음 수집 때 반영됩니다" 를 읽고 15분을 기다렸다.
 *
 * ## 왜 떼어 두나
 *
 * 이 판단이 틀려도 **화면은 멀쩡해 보인다.** 한 번만 묻고 포기해도, 안 들어왔는데
 * 들어왔다고 해도 그 자리에서는 그럴듯하다. 틀린 것은 사람이 기다리기 시작한 뒤에
 * 드러난다. 그래서 규칙을 여기 두고 단위시험으로 잠근다.
 *
 * DB 도 망도 모른다. "끌어오기" 와 "들어왔나" 를 받아 쓸 뿐이다.
 */

/** 몇 번까지 묻나. 첫 번째가 대개 들어온다. */
export const REFLECT_TRIES = 3;

/** 다시 묻기 전 기다리는 시간. 세 번째까지 가도 2초 아래다. */
export const REFLECT_WAIT_MS = 900;

export interface ReflectOptions {
  /** 몇 번까지 묻나. 1 이면 다시 묻지 않는다. */
  tries?: number;
  /** 다시 묻기 전 기다리는 시간(ms). */
  waitMs?: number;
  /** 기다리는 방법. 시험에서 실제로 기다리지 않게 갈아 끼운다. */
  sleep?: (ms: number) => Promise<void>;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * 들어올 때까지 끌어온다. 돌려주는 값은 **실제로 들어왔는가**다.
 *
 * 몇 번 물어도 안 보이면 거짓말하지 않고 false 다 — 화면이 "아직 안 보인다" 고 말할
 * 근거가 된다. 사람이 앞에서 기다리는 구간이라 오래 끌지 않는다.
 *
 * 첫 번째는 **기다리지 않고** 바로 묻는다. 대개 그 자리에서 들어오므로, 늘 1초를
 * 더 쓰게 만들 이유가 없다.
 *
 * `pull` 이 터져도 멈추지 않는다. 한 번 실패한 것이 다음 번 실패를 뜻하지 않고,
 * 쓰기는 이미 끝나서 되돌릴 수 없다 — 여기서 터뜨리면 사용자가 "전송 실패" 로 읽는다.
 */
export async function untilReflected(
  pull: () => Promise<unknown>,
  landed: () => Promise<boolean>,
  options: ReflectOptions = {},
): Promise<boolean> {
  const tries = Math.max(1, options.tries ?? REFLECT_TRIES);
  const waitMs = options.waitMs ?? REFLECT_WAIT_MS;
  const sleep = options.sleep ?? realSleep;

  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (attempt > 0) await sleep(waitMs);
    try {
      await pull();
    } catch {
      // 다음 번을 막지 않는다.
    }
    if (await landed()) return true;
  }
  return false;
}
