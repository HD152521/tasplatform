/**
 * 메모장 — 일정에 붙지 않는 메모의 저장·조회.
 *
 * `event_notes` 와 다르다. 그쪽은 일정 하나에 달려 "그 일을 하며 무엇을 했는지" 를
 * 적고 주간 정리의 재료가 된다. 여기는 **날짜에 걸지 않고** 그냥 적어 두는 자리다 —
 * 회의 내용, 조사 결과, 인수인계, 설정 값. 그럴 글을 적을 자리가 없어서 캘린더에
 * 억지로 날짜를 붙여 적고 있었다.
 *
 * 일정과 같은 규칙을 지킨다 — **모든 조회가 teamId 로 시작한다.** 팀을 생략하면
 * 전체가 되는 조회 함수를 두지 않는다(lib/calendar.ts 머리말과 같은 이유).
 *
 * server-only 를 붙이지 않는다. 노션으로 올리는 쪽을 수집기에서 돌릴 수 있다.
 */
import { assertValidTeamId } from "./config.ts";
import { isoNow } from "./dates.ts";
import type { Db } from "./db.ts";

/**
 * 노션 반영 상태. "만들어졌는지 모름" 은 두지 않는다(lib/schema.ts 머리말).
 *
 * `none` 은 **행이 없는 것**이다. 올린 적 없는 (메모, 사람) 짝은 표에 행이 없다.
 */
export type NotionState = "none" | "ok" | "failed";

export interface TeamNote {
  readonly noteId: number;
  readonly teamId: string;
  readonly title: string;
  readonly body: string;
  /** 쉼표로 이은 글자. 목록에서 거르는 데만 쓴다. */
  readonly tags: string;
  readonly createdBy: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * 메모 한 건을 **내가** 노션에 올린 기록.
 *
 * 노션 연결이 사람별이라(lib/notionAccount.ts) 같은 메모가 사람마다 다른 페이지로
 * 간다. 그래서 이 값은 **보는 사람에 따라 다르다** — 메모에 붙은 값이 아니다.
 */
export interface NotePublishRecord {
  readonly pageId: string;
  readonly url: string;
  readonly state: NotionState;
  readonly error: string;
  readonly tries: number;
  readonly syncedAt: string;
}

export const NO_PUBLISH: NotePublishRecord = {
  pageId: "", url: "", state: "none", error: "", tries: 0, syncedAt: "",
};

/** 화면에 필요한 사람 이름과 **내가 올린 기록**까지 붙인 메모. */
export interface TeamNoteView extends TeamNote {
  readonly createdByName: string;
  /** 보는 사람 기준이다. 다른 사람이 올렸는지는 여기 담기지 않는다. */
  readonly mine: NotePublishRecord;
}

interface NoteRowRaw {
  note_id: number;
  team_id: string;
  title: string;
  body: string;
  tags: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

function coerceNotionState(value: string): NotionState {
  return value === "ok" || value === "failed" ? value : "none";
}

function toNote(row: NoteRowRaw): TeamNote {
  return {
    noteId: Number(row.note_id),
    teamId: row.team_id,
    title: row.title,
    body: row.body,
    tags: row.tags ?? "",
    createdBy: row.created_by === null ? null : Number(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class NoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteError";
  }
}

/* ------------------------------------------------------------------ *
 * 쓰기
 * ------------------------------------------------------------------ */

export interface NoteInput {
  readonly teamId: string;
  readonly title: string;
  readonly body?: string;
  readonly tags?: string;
  readonly createdBy?: number | null;
}

/**
 * 제목만 있으면 저장한다.
 *
 * 본문을 필수로 두지 않는다 — 제목 한 줄만 적어 두고 나중에 채우는 쓰임이 실제로 있다
 * (적을 자리가 없어서 캘린더에 적던 글이 그런 글이었다). 대신 제목은 받는다. 제목이
 * 없으면 목록에서 무엇인지 알 수 없고, 노션 페이지도 이름 없이 만들어진다.
 */
export async function createNote(db: Db, input: NoteInput): Promise<number> {
  assertValidTeamId(input.teamId);
  const title = input.title.trim();
  if (title === "") throw new NoteError("메모 제목이 필요합니다.");
  const now = isoNow();
  return db.insertReturning(
    "INSERT INTO team_notes ("
      + " team_id, title, body, tags, created_by, created_at, updated_at"
      + ") VALUES (?,?,?,?,?,?,?)",
    [input.teamId, title, input.body ?? "", (input.tags ?? "").trim(), input.createdBy ?? null, now, now],
    "note_id",
  );
}

export interface NotePatch {
  readonly title?: string;
  readonly body?: string;
  readonly tags?: string;
}

/**
 * 메모 수정. **팀을 조건에 함께 넣는다** — note_id 만으로 고치면 남의 팀 메모를
 * id 추측으로 바꿀 수 있다(lib/calendar.ts updateEvent 와 같은 이유).
 */
export async function updateNote(
  db: Db,
  teamId: string,
  noteId: number,
  patch: NotePatch,
): Promise<TeamNote | null> {
  assertValidTeamId(teamId);
  const before = await getNote(db, teamId, noteId);
  if (before === null) return null;

  const title = (patch.title ?? before.title).trim();
  if (title === "") throw new NoteError("메모 제목이 필요합니다.");

  await db.run(
    "UPDATE team_notes SET title = ?, body = ?, tags = ?, updated_at = ?"
      + " WHERE team_id = ? AND note_id = ?",
    [title, patch.body ?? before.body, (patch.tags ?? before.tags).trim(), isoNow(), teamId, noteId],
  );
  return getNote(db, teamId, noteId);
}

/**
 * 메모 삭제. 올린 기록(note_notion_pages)도 함께 치운다.
 *
 * **노션 페이지는 건드리지 않는다.** 올린 글은 각자의 노션에 있고, 그걸 지우는 것은
 * 다른 결정이다(이미 남이 읽었을 수 있다). 외부 쓰기를 DB 삭제와 섞으면 실패했을 때
 * 어느 쪽이 남았는지 알 수 없다. 부르는 쪽이 그 사실을 사람에게 말해 준다.
 */
export async function deleteNote(db: Db, teamId: string, noteId: number): Promise<TeamNote | null> {
  assertValidTeamId(teamId);
  const existing = await getNote(db, teamId, noteId);
  if (existing === null) return null;
  await db.run("DELETE FROM note_notion_pages WHERE note_id = ?", [noteId]);
  await db.run("DELETE FROM team_notes WHERE team_id = ? AND note_id = ?", [teamId, noteId]);
  return existing;
}

/* ------------------------------------------------------------------ *
 * 읽기
 * ------------------------------------------------------------------ */

export async function getNote(db: Db, teamId: string, noteId: number): Promise<TeamNote | null> {
  assertValidTeamId(teamId);
  const row = await db.get<NoteRowRaw>(
    "SELECT * FROM team_notes WHERE team_id = ? AND note_id = ?",
    [teamId, noteId],
  );
  return row === undefined || row === null ? null : toNote(row);
}

/**
 * 메모 목록. **고친 순서**로 돌려준다.
 *
 * 만든 순서가 아니다 — 메모장은 "방금 손댄 것" 을 먼저 보는 자리다. 적어 둔 글을
 * 다시 꺼내 고치는 쓰임이 많아서, 만든 날짜로 줄을 세우면 방금 고친 글이 아래로 묻힌다.
 */
export async function listNotes(
  db: Db,
  teamId: string,
  options: {
    readonly limit?: number;
    readonly query?: string;
    /**
     * 보는 사람. 노션에 올린 기록을 이 사람 기준으로 붙인다.
     *
     * 주지 않으면 기록 없이 돌려준다(올린 적 없는 것과 같은 모양). 남의 기록을
     * 섞어 보여 주면 "내가 올렸다" 고 믿게 되고, 그 사람의 노션에는 아무것도 없다.
     */
    readonly viewerId?: number | null;
  } = {},
): Promise<TeamNoteView[]> {
  assertValidTeamId(teamId);
  const limit = options.limit === undefined ? 200 : Math.max(1, Math.min(500, options.limit));
  const query = (options.query ?? "").trim();

  const where = ["n.team_id = ?"];
  const args: unknown[] = [teamId];
  if (query !== "") {
    // 제목·본문·태그를 함께 본다. 적어 둔 글을 찾는 자리라 본문까지 봐야 쓸모가 있다.
    where.push("(n.title LIKE ? OR n.body LIKE ? OR n.tags LIKE ?)");
    const like = "%" + query + "%";
    args.push(like, like, like);
  }
  args.push(limit);

  const rows = await db.all<NoteRowRaw & { created_by_name: string | null }>(
    "SELECT n.*, u.display_name AS created_by_name"
      + " FROM team_notes n"
      + " LEFT JOIN users u ON u.user_id = n.created_by"
      + " WHERE " + where.join(" AND ")
      + " ORDER BY n.updated_at DESC, n.note_id DESC"
      + " LIMIT ?",
    args,
  );

  // 올린 기록은 한 번에 읽는다 — 메모마다 한 번씩 물으면 N+1 이 된다.
  const mine = new Map<number, NotePublishRecord>();
  const viewerId = options.viewerId ?? null;
  if (viewerId !== null && rows.length > 0) {
    const marks = rows.map(() => "?").join(",");
    const pages = await db.all<PageRowRaw>(
      "SELECT * FROM note_notion_pages WHERE user_id = ? AND note_id IN (" + marks + ")",
      [viewerId, ...rows.map((r) => Number(r.note_id))],
    );
    for (const page of pages) mine.set(Number(page.note_id), toRecord(page));
  }

  return rows.map((row) => ({
    ...toNote(row),
    createdByName: row.created_by_name ?? "",
    mine: mine.get(Number(row.note_id)) ?? NO_PUBLISH,
  }));
}

/* ------------------------------------------------------------------ *
 * 노션에 올린 기록 — (메모, 사람) 짝
 * ------------------------------------------------------------------ */

interface PageRowRaw {
  note_id: number;
  user_id: number;
  page_id: string;
  url: string;
  state: string;
  error: string;
  tries: number;
  synced_at: string;
}

function toRecord(row: PageRowRaw): NotePublishRecord {
  return {
    pageId: row.page_id ?? "",
    url: row.url ?? "",
    state: coerceNotionState(row.state ?? ""),
    error: row.error ?? "",
    tries: Number(row.tries ?? 0),
    syncedAt: row.synced_at ?? "",
  };
}

/** 내가 이 메모를 올린 기록. 없으면 NO_PUBLISH. */
export async function readPublishRecord(
  db: Db,
  noteId: number,
  userId: number,
): Promise<NotePublishRecord> {
  const row = await db.get<PageRowRaw>(
    "SELECT * FROM note_notion_pages WHERE note_id = ? AND user_id = ?",
    [noteId, userId],
  );
  return row === undefined || row === null ? NO_PUBLISH : toRecord(row);
}

/**
 * 올린 결과를 적는다.
 *
 * 실패를 **센다**(tries). 몇 번째 실패인지 보여 주려는 것이다 — 한 번 실패와 다섯 번
 * 실패는 사람이 할 일이 다르다(기다리기 / 설정 보기). 성공하면 0 으로 되돌린다.
 *
 * page_id·url 은 **빈 값으로 덮지 않는다.** 한 번 만들어진 페이지의 주소를 잃으면,
 * 다음 올리기가 그 페이지를 못 찾아 같은 글로 페이지를 하나 더 만든다.
 */
export async function recordNotionResult(
  db: Db,
  noteId: number,
  userId: number,
  result: {
    readonly pageId?: string;
    readonly url?: string;
    readonly state: Exclude<NotionState, "none">;
    readonly error?: string;
  },
): Promise<void> {
  const before = await readPublishRecord(db, noteId, userId);
  const pageId = (result.pageId ?? "") === "" ? before.pageId : (result.pageId as string);
  const url = (result.url ?? "") === "" ? before.url : (result.url as string);
  const tries = result.state === "failed" ? before.tries + 1 : 0;
  const now = isoNow();

  // 행이 없으면 넣고, 있으면 고친다. UPSERT 방언을 피한다 — SQLite 와 Postgres 를
  // 함께 쓰는 레포라(lib/db.ts) 한쪽에서만 되는 문법을 들이지 않는다.
  const updated = await db.run(
    "UPDATE note_notion_pages SET page_id = ?, url = ?, state = ?, error = ?, tries = ?, synced_at = ?"
      + " WHERE note_id = ? AND user_id = ?",
    [pageId, url, result.state, result.error ?? "", tries, now, noteId, userId],
  );
  // 고친 행이 없으면 처음 올린 것이다.
  if (before.syncedAt === "" && before.pageId === "" && before.state === "none") {
    void updated;
    await db.run(
      "INSERT INTO note_notion_pages (note_id, user_id, page_id, url, state, error, tries, synced_at)"
        + " VALUES (?,?,?,?,?,?,?,?)",
      [noteId, userId, pageId, url, result.state, result.error ?? "", tries, now],
    );
  }
}
