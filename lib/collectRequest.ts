/**
 * "지금 수집" 요청을 프로세스 사이로 넘긴다.
 *
 * 화면(웹)과 수집기(worker)는 **다른 기계**다. 웹에는 Playwright 가 없어 수집을 직접
 * 돌릴 수 없고, worker 는 15분마다 자식 프로세스로 collect.ts 를 돌린다. 그래서 버튼은
 * DB 에 "요청했다" 를 남기고, worker 가 자는 동안 그것을 보고 즉시 한 회차를 돌린다.
 * 둘을 잇는 것은 공유 DB 뿐이므로 app_state(키·값) 두 칸으로 끝낸다.
 *
 * 왜 큐가 아니라 시각 두 개인가: 요청은 쌓이지 않는다. 여러 번 눌러도 "가장 최근에
 * 요청했다" 하나면 충분하고, 한 회차가 그 요청들을 전부 만족시킨다. 큐를 두면 눌린
 * 횟수만큼 수집이 돌아 Broadcom 쪽에 쓸데없는 요청을 보낸다.
 *
 * server-only 를 붙이지 않는다. 수집기(Node)에서도 부른다.
 */
import { getAppState, setAppState } from "./appState.ts";
import { isoNow } from "./dates.ts";
import type { Db } from "./db.ts";

/** 마지막으로 사람이 "지금 수집" 을 누른 시각(ISO). */
const REQUESTED_KEY = "collect_requested_at";
/** worker 가 마지막으로 집어간 요청의 시각(ISO). */
const HANDLED_KEY = "collect_handled_at";

/** 요청을 남기고 그 시각을 돌려준다. 화면이 이 값으로 진행 상태를 따라간다. */
export async function requestCollect(db: Db): Promise<string> {
  const at = isoNow();
  await setAppState(db, REQUESTED_KEY, at);
  return at;
}

/**
 * 아직 처리되지 않은 요청이 있으면 그 시각을, 없으면 null.
 *
 * 문자열 비교로 충분하다 — ISO 8601 UTC 는 사전순이 시간순이다(isoNow 가 항상 같은
 * 형식으로 만든다). 두 기계의 시계가 어긋나도 판정이 뒤집히지 않는다: 두 값 모두
 * 같은 잣대(요청은 웹, 처리는 worker)로 비교되는 게 아니라 "처리한 것보다 나중에
 * 요청된 것이 있나" 만 보기 때문이다.
 */
export async function pendingCollectRequest(db: Db): Promise<string | null> {
  const requested = await getAppState(db, REQUESTED_KEY);
  if (requested === null || requested === "") return null;
  const handled = await getAppState(db, HANDLED_KEY);
  if (handled !== null && handled >= requested) return null;
  return requested;
}

/**
 * 그 요청을 집어갔다고 표시한다.
 *
 * 회차를 **돌리기 전에** 부른다. 뒤에 부르면, 수집이 5분 도는 동안 worker 가 같은
 * 요청을 다시 보고 또 돌린다. 수집 자체가 실패해도 다시 집지 않는다 — 어차피 다음
 * 정기 회차가 온다.
 */
export async function markCollectHandled(db: Db, at: string): Promise<void> {
  await setAppState(db, HANDLED_KEY, at);
}
