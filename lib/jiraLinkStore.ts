/**
 * SR 하나 ↔ 그 SR 로 끊은 Jira 티켓의 연결을 DB 에 남긴다.
 *
 * ## 무엇에 쓰나
 *
 * 1. SR 이 끝난 뒤 **어디에 댓글을 달지** 안다.
 * 2. 자동 게시의 울타리. 이 행이 있는 SR 만 자동 대상이다 — 행은 새 생성 버튼을 거친
 *    SR 에만 생기므로, 기능이 들어가기 **전**의 SR 은 구조적으로 빠진다. 날짜 계산도,
 *    배포 시각을 기억할 필요도 없다.
 *
 * ## server-only 를 붙이지 않는다
 *
 * 자동 게시를 웹이 하므로 지금은 라우트에서만 부르지만, DB 만 만지는 모듈이라 수집기나
 * 스크립트에서도 부를 수 있어야 한다. lib/attachmentJobs.ts 와 같은 결이다.
 */
import { isoNow } from "./dates.ts";
import type { Db } from "./db.ts";

export interface SrJiraLink {
  readonly requestId: number;
  readonly issueKey: string;
  readonly issueUrl: string;
  readonly track: string;
  readonly titleKo: string;
  readonly createdAt: string;
  /** 결과 댓글을 단 시각. 빈 문자열이면 아직 안 달았다. */
  readonly commentedAt: string;
}

interface Row {
  request_id: number;
  issue_key: string;
  issue_url: string;
  track: string;
  title_ko: string;
  created_at: string;
  commented_at: string;
}

/**
 * Postgres 는 **따옴표 없는 식별자를 소문자로 접는다.** `AS titleKo` 로 적으면
 * `titleko` 가 돌아와 값이 undefined 가 된다 — SQLite 는 대소문자를 지켜서
 * **운영에서만** 깨진다. 그래서 별칭을 쓰지 않고 snake_case 그대로 받아 여기서 옮긴다
 * (test/sqlAliases.test.ts 가 따옴표 없는 camelCase 별칭을 금지한다).
 */
function toLink(row: Row): SrJiraLink {
  return {
    requestId: row.request_id,
    issueKey: row.issue_key,
    issueUrl: row.issue_url,
    track: row.track,
    titleKo: row.title_ko,
    createdAt: row.created_at,
    commentedAt: row.commented_at,
  };
}

const COLUMNS = "request_id, issue_key, issue_url, track, title_ko, created_at, commented_at";

/**
 * 연결을 남긴다. 이미 있으면 **덮어쓴다.**
 *
 * 한 SR 에 티켓은 하나다. 같은 SR 로 두 번 들어오는 경우(재시도 등)에 행이 둘 생기면
 * 댓글을 어디에 달지 알 수 없게 된다. 그래서 request_id 를 기본키로 두고 덮어쓴다.
 */
export async function saveSrJiraLink(
  db: Db,
  link: {
    requestId: number;
    issueKey: string;
    issueUrl?: string;
    track?: string;
    titleKo?: string;
  },
): Promise<void> {
  await db.run(
    `INSERT INTO sr_jira_links (${COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, '')
     ON CONFLICT(request_id) DO UPDATE SET
       issue_key = excluded.issue_key,
       issue_url = excluded.issue_url,
       track = excluded.track,
       title_ko = excluded.title_ko`,
    [
      link.requestId,
      link.issueKey,
      link.issueUrl ?? "",
      link.track ?? "",
      link.titleKo ?? "",
      isoNow(),
    ],
  );
}

/** 그 SR 의 티켓. 없으면 null. */
export async function getSrJiraLink(db: Db, requestId: number): Promise<SrJiraLink | null> {
  const row = await db.get<Row>(
    `SELECT ${COLUMNS} FROM sr_jira_links WHERE request_id = ?`,
    [requestId],
  );
  return row === undefined ? null : toLink(row);
}

/**
 * 결과 댓글을 달았다고 표시한다.
 *
 * 이 표시가 없으면 다음 회차가 같은 티켓에 같은 댓글을 또 단다. 자동 게시는 조건으로
 * 대상을 고르는 구조라(스스로 낫는 대신) **표시가 곧 자물쇠**다.
 */
export async function markSrJiraCommented(db: Db, requestId: number): Promise<void> {
  await db.run(
    "UPDATE sr_jira_links SET commented_at = ? WHERE request_id = ?",
    [isoNow(), requestId],
  );
}
