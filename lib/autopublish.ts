/**
 * SR 이 끝나면 정리 문서를 Confluence 에 **자동으로** 올린다 — 대상 고르기와 자물쇠.
 *
 * 실제로 올리는 일은 app/api/autopublish 가 한다(게시 모듈이 server-only 라 라우트에서만
 * 부를 수 있다). 여기는 DB 만 만지므로 수집기나 스크립트에서도 부를 수 있다.
 *
 * ## 과거 것을 건드리지 않는 것이 가장 중요하다
 *
 * 종료는 **과거 SR 에서도 일어난다.** 지금 열려 있는 SR 수십 건이 이번 주에 닫히면,
 * 울타리가 없으면 첫 호출에 전부 Confluence 로 쏟아지고 그 전에 AI 를 수십 번 때린다.
 * 되돌리려면 Confluence 에서 손으로 지워야 한다. 그래서 **두 겹**으로 막는다.
 *
 *   1. `sr_jira_links` 에 행이 있는 SR 만. 그 행은 **새 생성 버튼을 거친 SR 에만**
 *      생기므로, 기능이 들어가기 전의 SR 은 구조적으로 빠진다.
 *   2. 기준 시각(`auto_publish_since_ms`) 이후에 **생성된** SR 만. 종료일이 아니라
 *      생성일로 본다 — "지금부터 올라온 것" 이 그 뜻이다.
 *
 * 같은 패턴이 이미 증명돼 있다. collector/prewarm.ts 가 워터마크를 처음 실행 때 박아
 * 두는 방식으로, 이미 끝나 있던 287건을 영영 건드리지 않게 막았다.
 *
 * ## 스스로 낫는다
 *
 * "올렸다" 표시(`case_summaries` 의 `confluence_published`)가 없는 것을 고르므로, 한 번
 * 실패해도 다음 회차가 다시 집는다. 일회성 신호를 놓치면 영구히 빠지는 구조와 다르다.
 * 대신 **영구히 실패하는 건**(요약이 안 되는 깨진 케이스 등)이 매번 AI 를 때리지 않게
 * 시도 횟수에 상한을 둔다.
 */
import { getAppState, initAppState, setAppState } from "./appState.ts";
import type { Db } from "./db.ts";

/** 이 시각 이후에 **생성된** SR 만 자동 게시 대상이다. 처음 돌 때 지금으로 박힌다. */
export const SINCE_KEY = "auto_publish_since_ms";

/** 지금 돌고 있는 회차의 시작 시각(ms). 비어 있으면 아무도 돌지 않는다. */
export const LOCK_KEY = "auto_publish_running_ms";

/** 한 회차에 올릴 상한. 요약이 없으면 건당 60초가 들 수 있다(collector/prewarm.ts). */
export const MAX_PER_RUN = Number(process.env.SR_AUTOPUBLISH_MAX ?? 3);

/** 한 건을 몇 번까지 시도할지. */
export const MAX_TRIES = Number(process.env.SR_AUTOPUBLISH_TRIES ?? 3);

/**
 * 자물쇠를 이만큼 지나면 버려진 것으로 본다.
 *
 * 돌던 요청이 죽으면(컨테이너 재시작 등) 자물쇠가 남아 아무도 못 돌게 된다. 한 회차가
 * 최대 몇 분이므로 넉넉히 둔다.
 */
export const LOCK_STALE_MS = 15 * 60 * 1000;

export interface Publishable {
  readonly requestId: number;
  readonly caseLabel: string;
  readonly subject: string;
  readonly issueKey: string;
  readonly tries: number;
}

interface Row {
  request_id: number;
  request_id_formatted: string;
  subject: string;
  issue_key: string;
  publish_tries: number;
}

/**
 * 올릴 대상.
 *
 * 종료 판정을 `isClosedStatus` 로 하지 않는다. 그 함수는 `cancel` 까지 종료로 보는데,
 * **취소된 SR 은 정리할 내용이 없다** — 올릴 문서가 아니다. 그리고 SQL 안에서 함수를
 * 부를 수 없다. collector/prewarm.ts 가 같은 이유로 같은 두 상태만 본다.
 *
 * 오래된 것부터 집는다 — 밀린 것이 계속 뒤로 밀리지 않게(prewarm 과 같은 순서).
 *
 * 별칭을 쓰지 않고 snake_case 로 받는다. Postgres 는 따옴표 없는 식별자를 소문자로
 * 접어서, `AS caseLabel` 로 적으면 운영에서만 undefined 가 된다.
 */
export async function findPublishable(
  db: Db,
  sinceMs: number,
  limit = MAX_PER_RUN,
  maxTries = MAX_TRIES,
): Promise<Publishable[]> {
  const rows = (await db.all(
    `SELECT c.request_id, c.request_id_formatted, c.subject, l.issue_key, l.publish_tries
       FROM cases c
       JOIN sr_jira_links l ON l.request_id = c.request_id
       LEFT JOIN case_summaries p
         ON p.request_id = c.request_id AND p.kind = 'confluence_published'
      WHERE p.request_id IS NULL
        AND lower(c.status) IN ('closed', 'resolved')
        AND c.created_on_ms IS NOT NULL
        AND c.created_on_ms > ?
        AND l.publish_tries < ?
      ORDER BY c.last_updated_ms ASC
      LIMIT ?`,
    [sinceMs, maxTries, limit],
  )) as Row[];

  return rows.map((row) => ({
    requestId: row.request_id,
    caseLabel: row.request_id_formatted,
    subject: row.subject,
    issueKey: row.issue_key,
    tries: row.publish_tries,
  }));
}

/** 시도 횟수를 하나 올린다. **올리기 전에** 부른다 — 죽어도 횟수는 남아야 한다. */
export async function bumpPublishTries(db: Db, requestId: number): Promise<void> {
  await db.run(
    "UPDATE sr_jira_links SET publish_tries = publish_tries + 1 WHERE request_id = ?",
    [requestId],
  );
}

/**
 * 올린 횟수를 하나 되돌린다.
 *
 * **판 전체가 문제일 때만** 부른다 — 토큰 만료, 설정 누락, Confluence 점검. 그런 실패는
 * 그 SR 의 문제가 아니라 환경의 문제인데, 횟수를 먹이면 **고친 뒤에도 영영 집히지
 * 않는다**(상한에 닿아서). 화면을 세 번 열면 대기 중인 전부가 상한에 닿는다.
 *
 * 0 밑으로는 내려가지 않게 한다.
 */
export async function refundPublishTries(db: Db, requestId: number): Promise<void> {
  await db.run(
    `UPDATE sr_jira_links SET publish_tries = CASE
       WHEN publish_tries > 0 THEN publish_tries - 1 ELSE 0 END
     WHERE request_id = ?`,
    [requestId],
  );
}

/**
 * 상한에 닿아 **포기한** 건수.
 *
 * 포기한 건은 대상 조회에서 빠지므로 어디에도 보이지 않는다. 그러면 자동 게시가 조용히
 * 멈춘 것을 아무도 모른다 — 자동 기능의 가장 흔한 고장이다. 세어서 보여 준다.
 */
export async function countGivenUp(db: Db, sinceMs: number, maxTries = MAX_TRIES): Promise<number> {
  const row = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM cases c
       JOIN sr_jira_links l ON l.request_id = c.request_id
       LEFT JOIN case_summaries p
         ON p.request_id = c.request_id AND p.kind = 'confluence_published'
      WHERE p.request_id IS NULL
        AND lower(c.status) IN ('closed', 'resolved')
        AND c.created_on_ms IS NOT NULL
        AND c.created_on_ms > ?
        AND l.publish_tries >= ?`,
    [sinceMs, maxTries],
  );
  return Number(row?.n ?? 0);
}

/**
 * 기준 시각을 읽는다. 없으면 **지금으로 박고 그 사실을 알린다.**
 *
 * 처음 돌 때는 아무것도 하지 않아야 한다. 그 순간 이미 종료돼 있던 SR 들이 전부 대상이
 * 되면 안 되기 때문이다(prewarm 과 같은 규칙).
 *
 * ## `stamp: false` 가 왜 필요한가
 *
 * 세어 보기(dry run)는 **아무것도 바꾸지 않아야 한다.** 박는 시각이 곧 "이때부터 대상"
 * 이므로, 기능을 켜기 몇 주 전에 세어 보다가 박히면 그 사이에 생성된 SR 이 전부 대상에
 * 들어온다. 일찍 박는 쪽이 안전해 보이지만 **반대로 그물을 넓히는 방향**이다.
 */
/**
 * 쓸 수 있는 기준 시각인가.
 *
 * **`Number.isFinite` 만으로는 모자라다.** `Number("")` 와 `Number(" ")` 는 0 이고
 * `isFinite(0)` 은 참이다. 그래서 키가 빈 문자열이거나 `0` 으로 남아 있으면 "멀쩡한
 * 값" 으로 통과하고, `created_on_ms > 0` 은 **모든 SR 에 참**이 된다 — 과거 SR 이
 * 전부 대상이 되어 화면을 열 때마다 상한만큼 쏟아진다.
 */
function usableSince(value: string | null): boolean {
  if (value === null || value.trim() === "") return false;
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0;
}

export async function readSince(
  db: Db,
  options: { stamp?: boolean } = {},
): Promise<{ sinceMs: number; first: boolean; initialized: boolean }> {
  const now = Date.now();
  const stamp = options.stamp !== false;

  if (!stamp) {
    const existing = await getAppState(db, SINCE_KEY);
    if (!usableSince(existing)) return { sinceMs: now, first: true, initialized: false };
    return { sinceMs: Number(existing), first: false, initialized: true };
  }

  const stored = await initAppState(db, SINCE_KEY, String(now));
  if (!usableSince(stored)) {
    // 값이 깨졌다. 지금으로 다시 박는다 — 과거를 열어 주는 쪽으로 기울지 않는다.
    await setAppState(db, SINCE_KEY, String(now));
    return { sinceMs: now, first: true, initialized: true };
  }
  return { sinceMs: Number(stored), first: stored === String(now), initialized: true };
}

/**
 * 이 회차를 맡는다. 이미 누가 돌고 있으면 false.
 *
 * 읽고 쓰는 사이에 틈이 있어 **완벽한 상호배제가 아니다.** 그래도 둘 수 있는 이유는,
 * 두 번 올라가는 것을 막는 진짜 장치가 따로 있기 때문이다 — 같은 제목의 문서가 있으면
 * 새로 만들지 않고 갱신한다(lib/confluencePublish.ts). 자물쇠는 쓸데없이 AI 를 두 번
 * 때리지 않으려는 것이다.
 */
export async function claimRun(db: Db, staleMs = LOCK_STALE_MS): Promise<boolean> {
  const now = Date.now();
  const running = Number(await getAppState(db, LOCK_KEY));
  if (Number.isFinite(running) && running > 0 && now - running < staleMs) return false;
  await setAppState(db, LOCK_KEY, String(now));
  return true;
}

/** 회차를 끝낸다. **반드시 부른다** — 안 부르면 자물쇠가 상할 때까지 아무도 못 돈다. */
export async function releaseRun(db: Db): Promise<void> {
  await setAppState(db, LOCK_KEY, "");
}
