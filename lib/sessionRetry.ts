/**
 * "세션 때문에 실패했으면 최신본을 끌어와 한 번만 다시" — 한 곳에 둔다.
 *
 * ## 세션은 만료 시각이 오기 전에도 죽는다
 *
 * Broadcom 계정이 하나다. 수집기가 재로그인하면 서버 쪽에서 앞선 세션이 무효가 되는데,
 * 그 쿠키의 만료 시각은 여전히 미래다. 그래서 파일만 보는 판정(hasTeamSession)은
 * "살아 있다" 고 답하고, 문턱은 통과하고, 정작 포털이 401 을 준다.
 * **401 을 받은 그 순간이 진실이다.** 그때 DB 최신본을 끌어와 한 번 다시 보낸다.
 *
 * ## 왜 읽기 경로에도 필요한가
 *
 * 쓰기 세 곳(create·reply·releases)은 이 세 줄을 각자 베껴 갖고 있었다. 읽기 쪽에는
 * 없었다 — 본문 이미지(/api/inline-image)는 401 을 그대로 "세션이 만료되었습니다" 로
 * 바꿔 돌려주었다. DB 에 살아 있는 세션이 있어도 쳐다보지 않으므로, 수집기가 재로그인한
 * 직후에는 케이스를 열 때마다 그림이 전부 깨졌다. 사람이 할 수 있는 일은 없는데 화면은
 * "로그인하세요" 라고 말한다. 같은 뜻의 코드가 다섯 곳으로 갈라지기 전에 여기 모은다.
 *
 * ## 왜 한 번만인가
 *
 * 사람이 화면 앞에서 기다리는 구간이다. 최신본이 이미 죽었다면 다음 시도도 죽는다.
 * refresh 가 false(바꿀 것이 없음)면 아예 다시 보내지 않는다 — 같은 쿠키로 또 보내면
 * 또 401 이고, 그만큼 사람을 더 기다리게 할 뿐이다.
 */
import { refreshTeamSessionFromDb } from "./sessionStore.ts";

export interface DeadSessionRetry<T> {
  /**
   * 한 번의 시도.
   *
   * ⚠ **세션을 이 안에서 다시 읽어야 한다.** 쿠키를 바깥에서 한 번 읽어 두고 쓰면
   * 재시도가 방금 끌어온 새 세션이 아니라 죽은 옛 쿠키를 그대로 또 보낸다.
   */
  readonly send: () => Promise<T>;
  /** 이 결과가 "세션이 죽어서" 실패한 것인가. */
  readonly deadSession: (value: T) => boolean;
  /** 버리는 결과를 닫는다(응답 본문 등). 실패해도 무시한다. */
  readonly discard?: (value: T) => Promise<unknown> | unknown;
  /** 최신본 끌어오기. 테스트가 주입한다. 기본은 DB 백업. */
  readonly refresh?: (teamId: string) => Promise<boolean>;
}

export async function retryOnDeadSession<T>(
  teamId: string,
  step: DeadSessionRetry<T>,
): Promise<T> {
  const first = await step.send();
  if (!step.deadSession(first)) return first;

  const refresh = step.refresh ?? refreshTeamSessionFromDb;
  if (!(await refresh(teamId))) return first;

  if (step.discard !== undefined) {
    try {
      await step.discard(first);
    } catch {
      // 버리는 값을 닫다가 난 오류로 재시도를 막지 않는다. 닫기는 뒷정리일 뿐이다.
    }
  }
  return step.send();
}
