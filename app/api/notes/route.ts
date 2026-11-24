/**
 * 메모장 — 메모 등록·수정·삭제, 노션으로 올리기.
 *
 * 모든 동작이 세션의 팀으로 묶인다 — 본문의 팀 값을 받지 않는다. 이 레포에서 "본문이
 * 보낸 team 을 믿는" 것이 팀 혼입의 뿌리였다(app/api/calendar/route.ts 와 같은 규약).
 *
 * 노션으로 올리는 것은 **사람이 누를 때만** 한다(action: "to-notion"). 저장할 때 따라
 * 나가지 않는다 — 메모에는 고객사 상황이 적힐 수 있고, 올린 글은 지워도 이미 읽힌 뒤다.
 * 저장이 외부로 새어 나가지 않는다는 것이 메모장을 쓸 수 있게 만드는 조건이다.
 *
 * 메모 내용은 감사 로그에 남기지 않는다. 무엇을 했는지(등록·수정·올리기)와 어느
 * 메모인지만 적는다.
 */
import { NextResponse } from "next/server";
import { actorOf, userFromRequestWith } from "../../../lib/appAuth.ts";
import { openDb, recordAudit } from "../../../lib/db.ts";
import { publishNoteToNotion } from "../../../lib/notePublish.ts";
import {
  NoteError,
  createNote,
  deleteNote,
  getNote,
  listNotes,
  updateNote,
  type NotePatch,
} from "../../../lib/notes.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UNAUTHORIZED = { ok: false, message: "로그인이 필요합니다." };
const NO_TEAM = { ok: false, message: "속한 팀이 없습니다. 팀 관리자에게 연결을 요청하세요." };

function fail(error: unknown): NextResponse {
  const status = error instanceof NoteError ? 400 : 500;
  return NextResponse.json(
    { ok: false, message: error instanceof Error ? error.message : String(error) },
    { status },
  );
}

/** 메모 목록. `?q=` 로 제목·본문·태그를 함께 찾는다. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const db = await openDb();
  try {
    const me = await userFromRequestWith(db, request);
    if (me === null) return NextResponse.json(UNAUTHORIZED, { status: 401 });
    if (me.teamId === "") return NextResponse.json(NO_TEAM, { status: 400 });

    const notes = await listNotes(db, me.teamId, { query: url.searchParams.get("q") ?? "" });
    return NextResponse.json({ ok: true, notes });
  } catch (error) {
    return fail(error);
  } finally {
    await db.close();
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, message: "요청 본문을 읽지 못했습니다." }, { status: 400 });
  }
  const str = (key: string): string => (typeof body[key] === "string" ? (body[key] as string) : "");

  const db = await openDb();
  try {
    const me = await userFromRequestWith(db, request);
    if (me === null) return NextResponse.json(UNAUTHORIZED, { status: 401 });
    if (me.teamId === "") return NextResponse.json(NO_TEAM, { status: 400 });

    /*
     * 노션으로 올린다. **사람이 누른 것만** 나간다.
     *
     * 실패해도 메모는 그대로 돌려준다 — 화면이 상태를 다시 맞출 수 있어야 한다
     * (다른 창에서 이미 올렸을 수도 있다).
     */
    if (body.action === "to-notion") {
      const noteId = Number(body.noteId);
      if (!Number.isInteger(noteId) || noteId <= 0) {
        return NextResponse.json({ ok: false, message: "메모 번호가 올바르지 않습니다." }, { status: 400 });
      }
      const result = await publishNoteToNotion(db, me.teamId, noteId);
      await recordAudit(db, {
        actor: actorOf(me), teamId: me.teamId, action: "note_to_notion", requestId: null,
        result: result.action === "failed" ? "failed" : "ok",
        detail: `note=${noteId} ${result.action}`,
      });
      return NextResponse.json(
        {
          ok: result.action !== "failed",
          message: result.message,
          note: await getNote(db, me.teamId, noteId),
        },
        { status: result.action === "failed" ? 400 : 200 },
      );
    }

    const noteId = await createNote(db, {
      teamId: me.teamId,
      title: str("title"),
      body: str("body"),
      tags: str("tags"),
      createdBy: me.userId,
    });
    await recordAudit(db, {
      actor: actorOf(me), teamId: me.teamId, action: "note_create", requestId: null,
      result: "ok", detail: `note=${noteId}`,
    });
    return NextResponse.json({ ok: true, note: await getNote(db, me.teamId, noteId) });
  } catch (error) {
    return fail(error);
  } finally {
    await db.close();
  }
}

/**
 * 메모 수정.
 *
 * 노션에 이미 올린 메모를 고쳐도 **따라 올리지 않는다.** 고치는 것과 밖으로 내보내는
 * 것은 다른 결정이다. 대신 화면이 "노션 쪽이 옛 내용" 임을 보여 준다(updated_at 과
 * notion_synced_at 을 비교한다).
 */
export async function PATCH(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, message: "요청 본문을 읽지 못했습니다." }, { status: 400 });
  }
  const noteId = Number(body.noteId);
  if (!Number.isInteger(noteId) || noteId <= 0) {
    return NextResponse.json({ ok: false, message: "메모 번호가 올바르지 않습니다." }, { status: 400 });
  }

  const db = await openDb();
  try {
    const me = await userFromRequestWith(db, request);
    if (me === null) return NextResponse.json(UNAUTHORIZED, { status: 401 });
    if (me.teamId === "") return NextResponse.json(NO_TEAM, { status: 400 });

    let patch: NotePatch = {};
    if (typeof body.title === "string") patch = { ...patch, title: body.title };
    if (typeof body.body === "string") patch = { ...patch, body: body.body };
    if (typeof body.tags === "string") patch = { ...patch, tags: body.tags };

    const after = await updateNote(db, me.teamId, noteId, patch);
    if (after === null) {
      return NextResponse.json({ ok: false, message: "그 메모를 찾을 수 없습니다." }, { status: 404 });
    }
    await recordAudit(db, {
      actor: actorOf(me), teamId: me.teamId, action: "note_update", requestId: null,
      result: "ok", detail: `note=${noteId}`,
    });
    return NextResponse.json({ ok: true, note: after });
  } catch (error) {
    return fail(error);
  } finally {
    await db.close();
  }
}

/**
 * 메모 삭제.
 *
 * **노션 페이지는 지우지 않는다.** 올린 글을 지우는 것은 다른 결정이고(이미 남이 읽었을
 * 수 있다), 외부 쓰기를 DB 삭제와 섞으면 실패했을 때 어느 쪽이 남았는지 알 수 없다.
 * 올린 적이 있는 메모였다면 그 사실을 응답으로 말해 준다.
 */
export async function DELETE(request: Request) {
  const noteId = Number(new URL(request.url).searchParams.get("noteId"));
  if (!Number.isInteger(noteId) || noteId <= 0) {
    return NextResponse.json({ ok: false, message: "메모 번호가 올바르지 않습니다." }, { status: 400 });
  }

  const db = await openDb();
  try {
    const me = await userFromRequestWith(db, request);
    if (me === null) return NextResponse.json(UNAUTHORIZED, { status: 401 });
    if (me.teamId === "") return NextResponse.json(NO_TEAM, { status: 400 });

    const removed = await deleteNote(db, me.teamId, noteId);
    if (removed === null) {
      return NextResponse.json({ ok: false, message: "그 메모를 찾을 수 없습니다." }, { status: 404 });
    }
    await recordAudit(db, {
      actor: actorOf(me), teamId: me.teamId, action: "note_delete", requestId: null,
      result: "ok", detail: `note=${noteId}`,
    });
    return NextResponse.json({
      ok: true,
      message:
        removed.notionPageId === ""
          ? "메모를 지웠습니다."
          : "메모를 지웠습니다. 노션에 올린 페이지는 그대로 남아 있습니다 — 필요하면 노션에서 지워주세요.",
      notionUrl: removed.notionUrl,
    });
  } catch (error) {
    return fail(error);
  } finally {
    await db.close();
  }
}
