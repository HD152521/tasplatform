/**
 * "지금 수집" 요청을 프로세스 사이로 넘긴다.
 *
 * 화면(웹)과 수집기(worker)는 **다른 기계**다. 웹에는 Playwright 가 없어 수집을 직접
 * 돌릴 수 없고, worker 는 15분마다 자식 프로세스로 collect.ts 를 돌린다. 그래서 버튼은
 * DB 에 "요청했다" 를 남기고, worker 가 자는 동안 그것을 보고 즉시 한 회차를 돌린다.
 * 둘을 잇는 것은 공유 DB 뿐이므로 app_state(키·값)로 끝낸다.
 *
 * ## 왜 시각이 아니라 번호인가
 *
 * 처음에는 요청 시각(ISO)과 처리 시각을 비교했다. 리눅스 CI 에서 깨졌다 —
 *
 *     처리 중에 들어온 요청은 남는다:  expected '2026-09-28T06:04:23.076Z', actual null
 *
 * isoNow() 는 밀리초까지다. 빠른 기계에서는 "worker 가 집어감 → 사람이 또 누름" 이
 * **같은 밀리초** 안에 일어나고, 그러면 처리 시각 >= 요청 시각 이 되어 새 요청이 조용히
 * 사라진다. 수집이 도는 동안 누른 요청이 없어지면 방금 올린 답변이 반영되지 않은 채
 * "끝났다" 가 된다. 테스트가 잡은 것이 그 경로다.
 *
 * 그래서 시계를 쓰지 않는다. 요청마다 1씩 오르는 번호를 두고 처리한 번호와 비교한다.
 * 두 기계의 시계가 어긋나도, 같은 밀리초에 몰려도 판정이 흔들리지 않는다.
 *
 * ## 왜 큐가 아닌가
 *
 * 요청은 쌓이지 않는다. 여러 번 눌러도 "가장 최근 번호" 하나면 충분하고, 한 회차가 그
 * 요청들을 전부 만족시킨다. 큐를 두면 눌린 횟수만큼 수집이 돌아 Broadcom 에 쓸데없는
 * 요청을 보낸다.
 *
 * server-only 를 붙이지 않는다. 수집기(Node)에서도 부른다.
 */
import { getAppState, setAppState } from "./appState.ts";
import { isoNow } from "./dates.ts";
import type { Db } from "./db.ts";

/** 사람이 누른 횟수(1씩 증가). 판정은 전적으로 이 값으로 한다. */
const REQUESTED_SEQ = "collect_requested_seq";
/** worker 가 마지막으로 집어간 번호. */
const HANDLED_SEQ = "collect_handled_seq";
/** 마지막 요청 시각. 판정에 쓰지 않는다 — 사람이 보기 위한 기록이다. */
const REQUESTED_AT = "collect_requested_at";

async function readSeq(db: Db, key: string): Promise<number> {
  const raw = await getAppState(db, key);
  const value = Number(raw ?? "");
  // 없거나 깨진 값은 0 으로 본다. 0 이면 "아직 아무 일도 없었다" 와 같다.
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export interface CollectRequest {
  /** 이 요청의 번호. 화면이 이 값으로 진행 상태를 따라간다. */
  readonly seq: number;
  /** 사람이 보기 위한 시각. 판정에 쓰지 않는다. */
  readonly at: string;
}

/** 요청을 남기고 번호를 돌려준다. */
export async function requestCollect(db: Db): Promise<CollectRequest> {
  const seq = (await readSeq(db, REQUESTED_SEQ)) + 1;
  const at = isoNow();
  await setAppState(db, REQUESTED_SEQ, String(seq));
  await setAppState(db, REQUESTED_AT, at);
  return { seq, at };
}

/** 아직 처리되지 않은 요청이 있으면 그 번호를, 없으면 null. */
export async function pendingCollectRequest(db: Db): Promise<number | null> {
  const requested = await readSeq(db, REQUESTED_SEQ);
  if (requested === 0) return null;
  const handled = await readSeq(db, HANDLED_SEQ);
  return requested > handled ? requested : null;
}

/** worker 가 그 번호까지 집어갔는지. 화면이 "집어갔나" 를 묻는 데 쓴다. */
export async function isCollectHandled(db: Db, seq: number): Promise<boolean> {
  return (await readSeq(db, HANDLED_SEQ)) >= seq;
}

/**
 * 그 번호까지 집어갔다고 표시한다.
 *
 * 회차를 **돌리기 전에** 부른다. 뒤에 부르면, 수집이 5분 도는 동안 worker 가 같은
 * 요청을 다시 보고 또 돌린다. 수집이 실패해도 다시 집지 않는다 — 다음 정기 회차가 온다.
 *
 * 이미 더 큰 번호가 찍혀 있으면 되돌리지 않는다. 되돌리면 처리한 요청이 되살아난다.
 */
export async function markCollectHandled(db: Db, seq: number): Promise<void> {
  if (seq <= (await readSeq(db, HANDLED_SEQ))) return;
  await setAppState(db, HANDLED_SEQ, String(seq));
}
