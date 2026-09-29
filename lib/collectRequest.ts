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
 * ## 왜 종류마다 번호를 따로 세는가
 *
 * 수집기가 셋이다(케이스·보안 공지·기술 문서). 번호를 하나로 공유하면 CVE 를 누른
 * 요청이 케이스 회차로 지워지고, 사람은 "완료" 를 보지만 CVE 는 하나도 안 받는다.
 * 겉으로 아무 표시가 없어 알아챌 방법도 없다. 그래서 종류마다 칸을 따로 둔다.
 *
 * server-only 를 붙이지 않는다. 수집기(Node)에서도 부른다.
 */
import { getAppState, setAppState } from "./appState.ts";
import { DEFAULT_COLLECT_KIND, type CollectKind } from "./collectKind.ts";
import { isoNow } from "./dates.ts";
import type { Db } from "./db.ts";

/**
 * 종류별 app_state 키.
 *
 * 케이스만 접두사가 없다. 옛 이름을 그대로 쓴다 — 이미 배포돼 돌고 있고, 웹과 수집기가
 * 따로 재시작된다. 이름을 바꾸면 한쪽은 새 키에 쓰고 다른 쪽은 옛 키를 보게 되어,
 * 버튼을 눌러도 아무 일도 일어나지 않는 구간이 생긴다(그동안 화면은 조용하다).
 */
function keysFor(kind: CollectKind): {
  requested: string; handled: string; requestedAt: string;
  finished: string; finishedOk: string;
} {
  const prefix = kind === DEFAULT_COLLECT_KIND ? "collect" : `collect_${kind}`;
  return {
    /** 사람이 누른 횟수(1씩 증가). 판정은 전적으로 이 값으로 한다. */
    requested: `${prefix}_requested_seq`,
    /** worker 가 마지막으로 집어간 번호. */
    handled: `${prefix}_handled_seq`,
    /** 마지막 요청 시각. 판정에 쓰지 않는다 — 사람이 보기 위한 기록이다. */
    requestedAt: `${prefix}_requested_at`,
    /** worker 가 자식 프로세스까지 끝낸 번호. */
    finished: `${prefix}_finished_seq`,
    /** 그 회차가 성공으로 끝났는지("1"/"0"). */
    finishedOk: `${prefix}_finished_ok`,
  };
}

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
export async function requestCollect(db: Db, kind: CollectKind): Promise<CollectRequest> {
  const keys = keysFor(kind);
  const seq = (await readSeq(db, keys.requested)) + 1;
  const at = isoNow();
  await setAppState(db, keys.requested, String(seq));
  await setAppState(db, keys.requestedAt, at);
  return { seq, at };
}

/** 아직 처리되지 않은 요청이 있으면 그 번호를, 없으면 null. */
export async function pendingCollectRequest(db: Db, kind: CollectKind): Promise<number | null> {
  const keys = keysFor(kind);
  const requested = await readSeq(db, keys.requested);
  if (requested === 0) return null;
  const handled = await readSeq(db, keys.handled);
  return requested > handled ? requested : null;
}

/** worker 가 그 번호까지 집어갔는지. 화면이 "집어갔나" 를 묻는 데 쓴다. */
export async function isCollectHandled(db: Db, kind: CollectKind, seq: number): Promise<boolean> {
  return (await readSeq(db, keysFor(kind).handled)) >= seq;
}

/**
 * 그 번호까지 집어갔다고 표시한다.
 *
 * 회차를 **돌리기 전에** 부른다. 뒤에 부르면, 수집이 5분 도는 동안 worker 가 같은
 * 요청을 다시 보고 또 돌린다. 수집이 실패해도 다시 집지 않는다 — 다음 정기 회차가 온다.
 *
 * 이미 더 큰 번호가 찍혀 있으면 되돌리지 않는다. 되돌리면 처리한 요청이 되살아난다.
 */
export async function markCollectHandled(db: Db, kind: CollectKind, seq: number): Promise<void> {
  const keys = keysFor(kind);
  if (seq <= (await readSeq(db, keys.handled))) return;
  await setAppState(db, keys.handled, String(seq));
}

export interface CollectOutcome {
  /** 끝난 요청 번호. 아직 아무것도 끝나지 않았으면 0. */
  readonly seq: number;
  /** 그 회차가 성공으로 끝났는지. */
  readonly ok: boolean;
}

/**
 * 그 번호의 회차가 끝났다고 표시한다. 자식 프로세스가 **끝난 뒤에** 부른다.
 *
 * 집어갔다는 표시(handled)와 나눠 둔 이유: handled 는 "중복 실행 금지" 를 위해 돌리기
 * 전에 찍어야 하고, 화면은 그것만으로 끝났는지 알 수 없다. 케이스 수집은 runs 에 회차를
 * 남겨 화면이 그걸 보지만, 보안 공지·기술 문서 수집기는 runs 에 아무것도 남기지 않는다
 * (collector/collect-cves.ts, collect-kb.ts — 표준출력에만 적는다). 그 둘은 이 표시가
 * 없으면 영원히 "수집 중" 으로 보인다.
 *
 * 성공 여부를 함께 남긴다. 없으면 실패한 회차도 "수집 완료" 로 보이는데, 그건 거짓말이다.
 */
export async function markCollectFinished(
  db: Db, kind: CollectKind, seq: number, ok: boolean,
): Promise<void> {
  const keys = keysFor(kind);
  if (seq <= (await readSeq(db, keys.finished))) return;
  await setAppState(db, keys.finished, String(seq));
  await setAppState(db, keys.finishedOk, ok ? "1" : "0");
}

/** 마지막으로 끝난 회차. 화면이 "내 번호까지 끝났나" 를 묻는 데 쓴다. */
export async function collectOutcome(db: Db, kind: CollectKind): Promise<CollectOutcome> {
  const keys = keysFor(kind);
  const seq = await readSeq(db, keys.finished);
  // 값이 없으면 실패로 보지 않는다 — 옛 배포가 남긴 상태일 수 있다. 성공으로 본다.
  return { seq, ok: (await getAppState(db, keys.finishedOk)) !== "0" };
}
