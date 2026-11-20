/**
 * 팀 캘린더 — 일정과 메모의 저장·조회.
 *
 * 일정은 **팀 전체 공개**다. 그래서 모든 조회가 teamId 로 시작한다 — 팀을 안 주는
 * 조회 함수를 두지 않는다. 이 레포에서 "teamId 를 생략하면 전체" 인 조회가 팀 혼입의
 * 뿌리였고(docs/plans/team-platform-plan.md 0장), 새 표에서는 그 틈을 만들지 않는다.
 *
 * 날짜는 'YYYY-MM-DD', 시각은 'HH:MM' 문자열이다. 이유는 lib/schema.ts 의
 * team_events 머리말과 lib/quickAdd.ts 머리말에 있다(시간대 때문에 하루가 밀리는 것).
 *
 * server-only 를 붙이지 않는다. 주간 정리(S6)를 수집기 쪽 worker 가 돌릴 수 있다.
 */
import { assertValidTeamId } from "./config.ts";
import { isoNow } from "./dates.ts";
import type { Db } from "./db.ts";
import { addDays, isDateString } from "./quickAdd.ts";

/** 일정 상태. 취소는 **삭제와 다르다** — "하기로 했는데 안 했다" 는 기록이다. */
export type EventState = "planned" | "doing" | "done" | "canceled";

const STATES: readonly EventState[] = ["planned", "doing", "done", "canceled"];

export function coerceState(value: unknown): EventState {
  return typeof value === "string" && (STATES as readonly string[]).includes(value)
    ? (value as EventState)
    : "planned";
}

/** Jira 반영 상태. `unknown` 은 "만들어졌는지 모른다" 다(lib/jiraWrite.ts 의 그 상태). */
export type JiraState = "none" | "ok" | "unknown" | "failed";

export interface TeamEvent {
  readonly eventId: number;
  readonly teamId: string;
  readonly title: string;
  readonly body: string;
  readonly kind: string;
  /** 전산망/센터. '/' 로 이은 문자열('개발/운영'). Jira 제목의 대괄호가 된다. */
  readonly scopes: string;
  /** 법인('은행'|'중앙회'|'본사'). Jira 상위 에픽을 고른다. 없으면 ''. */
  readonly corp: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly assigneeUserId: number | null;
  /** 팀원과 못 맞춘 담당자 이름. 맞춘 경우에도 적어 둔 글자를 남긴다. */
  readonly assigneeLabel: string;
  readonly state: EventState;
  readonly createdBy: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly jiraKey: string;
  readonly jiraUrl: string;
  readonly jiraState: JiraState;
  readonly jiraError: string;
  readonly jiraTries: number;
  readonly jiraSyncedAt: string;
}

/** 화면에 필요한 사람 이름까지 붙인 일정. */
export interface TeamEventView extends TeamEvent {
  readonly assigneeName: string;
  readonly createdByName: string;
  readonly noteCount: number;
}

interface EventRowRaw {
  event_id: number;
  team_id: string;
  title: string;
  body: string;
  kind: string;
  scopes: string;
  corp: string;
  start_date: string;
  end_date: string;
  start_time: string;
  end_time: string;
  assignee_user_id: number | null;
  assignee_label: string;
  state: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  jira_key: string;
  jira_url: string;
  jira_state: string;
  jira_error: string;
  jira_tries: number;
  jira_synced_at: string;
}

function toEvent(row: EventRowRaw): TeamEvent {
  return {
    eventId: Number(row.event_id),
    teamId: row.team_id,
    title: row.title,
    body: row.body,
    kind: row.kind,
    scopes: row.scopes ?? "",
    corp: row.corp ?? "",
    startDate: row.start_date,
    endDate: row.end_date,
    startTime: row.start_time,
    endTime: row.end_time,
    assigneeUserId: row.assignee_user_id === null ? null : Number(row.assignee_user_id),
    assigneeLabel: row.assignee_label,
    state: coerceState(row.state),
    createdBy: row.created_by === null ? null : Number(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    jiraKey: row.jira_key,
    jiraUrl: row.jira_url,
    jiraState: coerceJiraState(row.jira_state),
    jiraError: row.jira_error,
    jiraTries: Number(row.jira_tries ?? 0),
    jiraSyncedAt: row.jira_synced_at,
  };
}

function coerceJiraState(value: string): JiraState {
  return value === "ok" || value === "unknown" || value === "failed" ? value : "none";
}

export class CalendarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarError";
  }
}

/* ------------------------------------------------------------------ *
 * 쓰기
 * ------------------------------------------------------------------ */

export interface EventInput {
  readonly teamId: string;
  readonly title: string;
  readonly body?: string;
  readonly kind?: string;
  readonly scopes?: string;
  readonly corp?: string;
  readonly startDate: string;
  readonly endDate?: string;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly assigneeUserId?: number | null;
  readonly assigneeLabel?: string;
  readonly state?: EventState;
  readonly createdBy?: number | null;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 저장 전 검사. **여기서 막지 않으면 달 그리드가 조용히 비어 보인다** —
 * 날짜가 깨진 행은 어느 칸에도 걸리지 않아서, 저장은 성공했는데 화면에는 없다.
 */
function validate(input: EventInput): { startDate: string; endDate: string } {
  assertValidTeamId(input.teamId);
  if (input.title.trim() === "") throw new CalendarError("일정 제목이 필요합니다.");
  if (!isDateString(input.startDate)) {
    throw new CalendarError(`시작 날짜가 올바르지 않습니다: ${JSON.stringify(input.startDate)}`);
  }
  const endDate = input.endDate === undefined || input.endDate === "" ? input.startDate : input.endDate;
  if (!isDateString(endDate)) {
    throw new CalendarError(`종료 날짜가 올바르지 않습니다: ${JSON.stringify(endDate)}`);
  }
  if (endDate < input.startDate) {
    throw new CalendarError("종료 날짜가 시작 날짜보다 앞입니다.");
  }
  for (const [label, value] of [["시작 시각", input.startTime], ["종료 시각", input.endTime]] as const) {
    if (value !== undefined && value !== "" && !TIME_PATTERN.test(value)) {
      throw new CalendarError(`${label}이 올바르지 않습니다: ${JSON.stringify(value)}`);
    }
  }
  return { startDate: input.startDate, endDate };
}

export async function createEvent(db: Db, input: EventInput): Promise<number> {
  const { startDate, endDate } = validate(input);
  const now = isoNow();
  return db.insertReturning(
    `INSERT INTO team_events (
       team_id, title, body, kind, scopes, corp,
       start_date, end_date, start_time, end_time,
       assignee_user_id, assignee_label, state, created_by, created_at, updated_at,
       jira_key, jira_url, jira_state, jira_error, jira_tries, jira_synced_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'','','none','',0,'')`,
    [
      input.teamId,
      input.title.trim(),
      input.body ?? "",
      (input.kind ?? "").trim(),
      (input.scopes ?? "").trim(),
      (input.corp ?? "").trim(),
      startDate,
      endDate,
      input.startTime ?? "",
      input.endTime ?? "",
      input.assigneeUserId ?? null,
      (input.assigneeLabel ?? "").trim(),
      input.state ?? "planned",
      input.createdBy ?? null,
      now,
      now,
    ],
    "event_id",
  );
}

export interface EventPatch {
  readonly title?: string;
  readonly body?: string;
  readonly kind?: string;
  readonly scopes?: string;
  readonly corp?: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly assigneeUserId?: number | null;
  readonly assigneeLabel?: string;
  readonly state?: EventState;
}

/**
 * 일정 수정. **팀을 조건에 함께 넣는다** — event_id 만으로 고치면 남의 팀 일정을
 * id 추측으로 바꿀 수 있다. 사내망이라도 그 틈은 공짜로 막을 수 있다.
 *
 * 바뀐 것이 없으면 아무것도 쓰지 않고 false 를 돌려준다. Jira 반영(S5)이 "무엇이
 * 바뀌었나" 로 할 일을 정하므로, 안 바뀐 저장이 updated_at 만 올리면 쓸데없는
 * Jira 호출이 생긴다.
 */
export async function updateEvent(
  db: Db,
  teamId: string,
  eventId: number,
  patch: EventPatch,
): Promise<TeamEvent | null> {
  assertValidTeamId(teamId);
  const before = await getEvent(db, teamId, eventId);
  if (before === null) return null;

  const merged: EventInput = {
    teamId,
    title: patch.title ?? before.title,
    body: patch.body ?? before.body,
    kind: patch.kind ?? before.kind,
    scopes: patch.scopes ?? before.scopes,
    corp: patch.corp ?? before.corp,
    startDate: patch.startDate ?? before.startDate,
    endDate: patch.endDate ?? before.endDate,
    startTime: patch.startTime ?? before.startTime,
    endTime: patch.endTime ?? before.endTime,
    assigneeUserId: patch.assigneeUserId === undefined ? before.assigneeUserId : patch.assigneeUserId,
    assigneeLabel: patch.assigneeLabel ?? before.assigneeLabel,
    state: patch.state ?? before.state,
  };
  const { startDate, endDate } = validate(merged);

  await db.run(
    `UPDATE team_events SET
       title = ?, body = ?, kind = ?, scopes = ?, corp = ?, start_date = ?, end_date = ?,
       start_time = ?, end_time = ?, assignee_user_id = ?, assignee_label = ?,
       state = ?, updated_at = ?
     WHERE team_id = ? AND event_id = ?`,
    [
      merged.title.trim(),
      merged.body ?? "",
      (merged.kind ?? "").trim(),
      (merged.scopes ?? "").trim(),
      (merged.corp ?? "").trim(),
      startDate,
      endDate,
      merged.startTime ?? "",
      merged.endTime ?? "",
      merged.assigneeUserId ?? null,
      (merged.assigneeLabel ?? "").trim(),
      merged.state ?? "planned",
      isoNow(),
      teamId,
      eventId,
    ],
  );
  return getEvent(db, teamId, eventId);
}

/**
 * 일정 삭제. 메모도 함께 치운다.
 *
 * Jira 이슈까지 지우는 것은 **부르는 쪽**(lib/calendarJira.ts)의 일이다 — 여기서
 * 외부에 쓰기를 하면 DB 트랜잭션과 외부 호출이 섞여, 실패했을 때 어느 쪽이
 * 남았는지 알 수 없게 된다.
 */
export async function deleteEvent(db: Db, teamId: string, eventId: number): Promise<boolean> {
  assertValidTeamId(teamId);
  const existing = await getEvent(db, teamId, eventId);
  if (existing === null) return false;
  await db.run("DELETE FROM event_notes WHERE event_id = ?", [eventId]);
  await db.run("DELETE FROM team_events WHERE team_id = ? AND event_id = ?", [teamId, eventId]);
  return true;
}

/* ------------------------------------------------------------------ *
 * 읽기
 * ------------------------------------------------------------------ */

export async function getEvent(db: Db, teamId: string, eventId: number): Promise<TeamEvent | null> {
  const row = await db.get<EventRowRaw>(
    "SELECT * FROM team_events WHERE team_id = ? AND event_id = ?",
    [teamId, eventId],
  );
  return row === undefined ? null : toEvent(row);
}

/**
 * 기간에 **걸치는** 일정 전부.
 *
 * `start_date <= to AND end_date >= from` — 여러 날에 걸친 일정이 기간 안으로 일부만
 * 들어와도 잡아야 한다. 시작일만 보면 "11/28~12/3 작업" 이 12월 달력에서 사라진다.
 */
export async function listEventsBetween(
  db: Db,
  teamId: string,
  from: string,
  to: string,
): Promise<TeamEventView[]> {
  assertValidTeamId(teamId);
  if (!isDateString(from) || !isDateString(to)) {
    throw new CalendarError("조회 기간이 올바르지 않습니다.");
  }

  const rows = await db.all<EventRowRaw & {
    assignee_name: string | null;
    creator_name: string | null;
    note_count: number;
  }>(
    `SELECT e.*,
            a.display_name AS assignee_name,
            c.display_name AS creator_name,
            (SELECT COUNT(*) FROM event_notes n WHERE n.event_id = e.event_id) AS note_count
       FROM team_events e
       LEFT JOIN users a ON a.user_id = e.assignee_user_id
       LEFT JOIN users c ON c.user_id = e.created_by
      WHERE e.team_id = ? AND e.start_date <= ? AND e.end_date >= ?
      ORDER BY e.start_date ASC,
               CASE WHEN e.start_time = '' THEN 0 ELSE 1 END ASC,
               e.start_time ASC,
               e.event_id ASC`,
    [teamId, to, from],
  );

  return rows.map((row) => ({
    ...toEvent(row),
    // 팀원과 맞춘 일정은 **지금의 이름**을 쓴다. 이름을 바꾼 사람의 옛 일정이
    // 옛 이름으로 남아 있으면 주간 정리에서 두 사람처럼 보인다.
    assigneeName: row.assignee_name ?? row.assignee_label,
    createdByName: row.creator_name ?? "",
    noteCount: Number(row.note_count ?? 0),
  }));
}

/**
 * 그 달에 걸치는 일정. `month` 는 'YYYY-MM'.
 *
 * `async` 로 둔다 — 형식 오류를 **던지는** 함수가 동기였을 때, 부르는 쪽의
 * `.catch()` 를 그냥 통과해 요청을 500 으로 떨어뜨렸다. 실패가 늘 거절(rejection)로
 * 오게 맞춘다.
 */
export async function listEventsInMonth(
  db: Db,
  teamId: string,
  month: string,
): Promise<TeamEventView[]> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new CalendarError(`달 형식이 올바르지 않습니다: ${JSON.stringify(month)}`);
  }
  const from = `${month}-01`;
  // 그 달 마지막 날 = 다음 달 1일의 하루 전.
  const [y, m] = month.split("-").map(Number) as [number, number];
  const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return listEventsBetween(db, teamId, from, addDays(nextMonth, -1));
}

/* ------------------------------------------------------------------ *
 * 메모 — "누가 무슨 내용을 했는지"
 * ------------------------------------------------------------------ */

export interface EventNote {
  readonly noteId: number;
  readonly eventId: number;
  readonly userId: number | null;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
}

/**
 * 메모 한 줄. 작성자를 **글자로도** 남긴다(`author`).
 *
 * user_id 만 두면 그 사람이 팀에서 빠지거나 계정이 지워졌을 때 "누가 적었는지" 가
 * 사라진다. 주간 정리의 사람별 섹션이 그 값으로 갈라지므로 글자를 함께 둔다.
 */
export async function addEventNote(
  db: Db,
  teamId: string,
  eventId: number,
  note: { userId: number | null; author: string; body: string },
): Promise<number> {
  const event = await getEvent(db, teamId, eventId);
  if (event === null) throw new CalendarError("그 일정을 찾을 수 없습니다.");
  if (note.body.trim() === "") throw new CalendarError("메모 내용이 비었습니다.");

  return db.insertReturning(
    "INSERT INTO event_notes (event_id, user_id, author, body, created_at) VALUES (?,?,?,?,?)",
    [eventId, note.userId, note.author, note.body.trim(), isoNow()],
    "note_id",
  );
}

export async function listEventNotes(db: Db, teamId: string, eventId: number): Promise<EventNote[]> {
  const event = await getEvent(db, teamId, eventId);
  if (event === null) return [];
  const rows = await db.all<{
    note_id: number;
    event_id: number;
    user_id: number | null;
    author: string;
    body: string;
    created_at: string;
  }>("SELECT * FROM event_notes WHERE event_id = ? ORDER BY note_id ASC", [eventId]);

  return rows.map((row) => ({
    noteId: Number(row.note_id),
    eventId: Number(row.event_id),
    userId: row.user_id === null ? null : Number(row.user_id),
    author: row.author,
    body: row.body,
    createdAt: row.created_at,
  }));
}

export async function deleteEventNote(
  db: Db,
  teamId: string,
  eventId: number,
  noteId: number,
): Promise<boolean> {
  const event = await getEvent(db, teamId, eventId);
  if (event === null) return false;
  const result = await db.run("DELETE FROM event_notes WHERE event_id = ? AND note_id = ?", [
    eventId,
    noteId,
  ]);
  return result.changes > 0;
}

/* ------------------------------------------------------------------ *
 * 담당자 맞추기
 * ------------------------------------------------------------------ */

export interface AssigneeCandidate {
  readonly userId: number;
  readonly displayName: string;
  readonly loginId: string;
}

/**
 * `@이름` 을 팀원과 맞춘다. 못 맞추면 null — 그래도 **글자는 남긴다**(assignee_label).
 *
 * 맞추는 순서: 이름 완전일치 → 아이디 완전일치 → 이름이 그 글자로 시작 → 아이디가
 * 그 글자로 시작. 여럿이 걸리면 **맞추지 않는다** — 엉뚱한 사람에게 일을 배정하는
 * 것이 담당자가 비는 것보다 나쁘다.
 */
export function matchAssignee(
  label: string,
  members: readonly AssigneeCandidate[],
): AssigneeCandidate | null {
  const needle = label.trim().toLowerCase();
  if (needle === "") return null;

  const tries: Array<(m: AssigneeCandidate) => boolean> = [
    (m) => m.displayName.toLowerCase() === needle,
    (m) => m.loginId.toLowerCase() === needle,
    (m) => m.displayName.toLowerCase().startsWith(needle),
    (m) => m.loginId.toLowerCase().startsWith(needle),
    // 한국 이름은 성을 떼고 부르는 일이 많다("안용식" → "용식").
    (m) => m.displayName.toLowerCase().endsWith(needle),
  ];

  for (const matches of tries) {
    const found = members.filter(matches);
    if (found.length === 1) return found[0] as AssigneeCandidate;
    if (found.length > 1) return null;
  }
  return null;
}
