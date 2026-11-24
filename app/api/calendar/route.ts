/**
 * 팀 캘린더 — 일정 등록·수정·삭제, 메모.
 *
 * 한 줄 입력은 **여기서 파싱한다**(lib/quickAdd.ts). 화면도 같은 함수로 미리보기를
 * 그리므로, 미리보기와 저장 결과가 어긋날 길이 없다.
 *
 * 모든 동작이 세션의 팀으로 묶인다 — 본문의 팀 값을 받지 않는다. 이 레포에서
 * "본문이 보낸 team 을 믿는" 것이 팀 혼입의 뿌리였다(계획서 0장).
 *
 * Jira 반영은 저장이 끝난 **뒤에** 한 번 시도하고, 실패해도 저장은 되돌리지 않는다.
 * 캘린더는 Jira 없이도 완결 동작해야 한다(S4 인수 조건).
 */
import { NextResponse } from "next/server";
import { actorOf, userFromRequestWith } from "../../../lib/appAuth.ts";
import {
  CalendarError,
  addEventNote,
  coerceState,
  createEvent,
  deleteEvent,
  deleteEventNote,
  getEvent,
  listEventNotes,
  listEventsInMonth,
  matchAssignee,
  updateEvent,
  type EventPatch,
} from "../../../lib/calendar.ts";
import { postNoteToJira, syncEventToJira, removeEventFromJira } from "../../../lib/calendarJira.ts";
import { openDb, recordAudit } from "../../../lib/db.ts";
import { classifyTags } from "../../../lib/jiraHouseStyle.ts";
import { parseQuickAdd } from "../../../lib/quickAdd.ts";
import { listTeamMembers } from "../../../lib/users.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UNAUTHORIZED = { ok: false, message: "로그인이 필요합니다." };
const NO_TEAM = { ok: false, message: "속한 팀이 없습니다. 팀 관리자에게 연결을 요청하세요." };

function fail(error: unknown): NextResponse {
  const status = error instanceof CalendarError ? 400 : 500;
  return NextResponse.json(
    { ok: false, message: error instanceof Error ? error.message : String(error) },
    { status },
  );
}

/** `?month=YYYY-MM` 의 일정 목록. 메모까지 필요하면 `?eventId=` 로 한 건을 묻는다. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const db = await openDb();
  try {
    const me = await userFromRequestWith(db, request);
    if (me === null) return NextResponse.json(UNAUTHORIZED, { status: 401 });
    if (me.teamId === "") return NextResponse.json(NO_TEAM, { status: 400 });

    const eventIdRaw = url.searchParams.get("eventId");
    if (eventIdRaw !== null) {
      const eventId = Number(eventIdRaw);
      if (!Number.isInteger(eventId)) {
        return NextResponse.json({ ok: false, message: "일정 번호가 올바르지 않습니다." }, { status: 400 });
      }
      const event = await getEvent(db, me.teamId, eventId);
      if (event === null) {
        return NextResponse.json({ ok: false, message: "그 일정을 찾을 수 없습니다." }, { status: 404 });
      }
      return NextResponse.json({
        ok: true,
        event,
        notes: await listEventNotes(db, me.teamId, eventId),
      });
    }

    const month = url.searchParams.get("month") ?? "";
    return NextResponse.json({ ok: true, events: await listEventsInMonth(db, me.teamId, month) });
  } catch (error) {
    return fail(error);
  } finally {
    await db.close();
  }
}

/**
 * 등록. 한 줄 입력(`line` + `today`) 또는 칸별 값(`title`·`startDate`…) 둘 다 받는다.
 *
 * `today` 를 **화면이 보낸다** — 서버가 UTC 면 "내일" 이 하루 어긋난다(lib/quickAdd.ts).
 */
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

    // 메모 추가는 같은 주소의 다른 동작이다.
    if (body.action === "note") {
      const eventId = Number(body.eventId);
      if (!Number.isInteger(eventId)) {
        return NextResponse.json({ ok: false, message: "일정 번호가 올바르지 않습니다." }, { status: 400 });
      }
      await addEventNote(db, me.teamId, eventId, {
        userId: me.userId,
        author: me.displayName === "" ? me.loginId : me.displayName,
        body: str("body"),
      });
      return NextResponse.json({
        ok: true,
        notes: await listEventNotes(db, me.teamId, eventId),
      });
    }

    // 메모 한 건을 Jira 코멘트로 올린다. **사람이 고른 것만** 나간다 —
    // 메모에는 고객사 상황이 적힐 수 있고 코멘트는 지워도 알림이 이미 간 뒤다
    // (lib/calendarJira.ts postNoteToJira).
    if (body.action === "note-to-jira") {
      const eventId = Number(body.eventId);
      const noteId = Number(body.noteId);
      if (!Number.isInteger(eventId) || !Number.isInteger(noteId)) {
        return NextResponse.json({ ok: false, message: "메모 번호가 올바르지 않습니다." }, { status: 400 });
      }
      const result = await postNoteToJira(db, me.teamId, eventId, noteId);
      await recordAudit(db, {
        actor: actorOf(me), teamId: me.teamId, action: "note_to_jira", requestId: null,
        result: result.ok ? "ok" : "failed", detail: `event=${eventId} note=${noteId}`,
      });
      // 실패해도 목록은 돌려준다 — 화면이 "올림" 표시를 다시 맞출 수 있어야 한다.
      return NextResponse.json({
        ok: result.ok,
        message: result.message,
        notes: await listEventNotes(db, me.teamId, eventId),
      }, { status: result.ok ? 200 : 400 });
    }

    const members = (await listTeamMembers(db, me.teamId)).map((m) => ({
      userId: m.userId,
      displayName: m.displayName,
      loginId: m.loginId,
    }));

    /*
     * Jira 에 올릴 것인가. **없으면 올리지 않는다.**
     *
     * 캘린더에 적히는 것은 Jira 이슈가 될 일보다 그냥 적어 두는 일(개인 일정·공유
     * 메모·기억용 기록)이 훨씬 많다. 기본을 "올린다" 로 두면 그 전부가 외부에 글로
     * 남고, 지워도 알림은 이미 갔다. 되돌릴 수 없는 쪽을 기본으로 둘 수는 없다.
     * 화면은 둘 다 명시해서 보낸다.
     */
    const jiraWanted = body.jiraWanted === true;

    const line = str("line").trim();
    let input;
    if (line !== "") {
      const parsed = parseQuickAdd(line, str("today"));
      if (parsed.title === "") {
        return NextResponse.json(
          { ok: false, message: "일정 제목이 비었습니다. 날짜·태그 말고 할 일도 적어 주세요." },
          { status: 400 },
        );
      }
      const matched = matchAssignee(parsed.assignee, members);
      // 태그를 망·법인·성격으로 가른다. 이 팀의 Jira 양식이 그 셋을 서로 다른 자리에
      // 쓰기 때문이다(제목 대괄호 / 상위 에픽 / 라벨 — lib/jiraHouseStyle.ts).
      const tags = classifyTags(parsed.kinds);
      input = {
        teamId: me.teamId,
        title: parsed.title,
        kind: tags.rest[0] ?? "",
        scopes: tags.scopes.join("/"),
        corp: tags.corp ?? "",
        startDate: parsed.startDate,
        endDate: parsed.endDate,
        startTime: parsed.startTime,
        endTime: parsed.endTime,
        assigneeUserId: matched?.userId ?? null,
        assigneeLabel: parsed.assignee,
        body: str("body"),
        createdBy: me.userId,
        jiraWanted,
      };
    } else {
      // 폼에서 온 경로. 태그를 **배열로** 받아 한 줄 입력과 **같은 분류 함수**를 쓴다 —
      // 두 경로가 다르게 분류하면 같은 일정이 어떻게 적었느냐에 따라 다른 Jira 제목이 된다.
      const tagList = Array.isArray(body.tags)
        ? (body.tags as unknown[]).filter((t): t is string => typeof t === "string")
        : str("kind") === ""
          ? []
          : [str("kind")];
      const tags = classifyTags(tagList);
      // 담당자는 폼이 **id 로** 보낸다. 이름 맞추기보다 확실하다(동명이인이 없다).
      const pickedId = Number(body.assigneeUserId);
      const matched = Number.isInteger(pickedId) && pickedId > 0
        ? members.find((m) => m.userId === pickedId) ?? null
        : matchAssignee(str("assignee"), members);
      input = {
        teamId: me.teamId,
        title: str("title"),
        kind: tags.rest[0] ?? "",
        scopes: tags.scopes.join("/"),
        corp: tags.corp ?? "",
        startDate: str("startDate"),
        endDate: str("endDate"),
        startTime: str("startTime"),
        endTime: str("endTime"),
        assigneeUserId: matched?.userId ?? null,
        assigneeLabel: matched?.displayName ?? str("assignee"),
        body: str("body"),
        createdBy: me.userId,
        jiraWanted,
      };
    }

    const eventId = await createEvent(db, input);
    await recordAudit(db, {
      actor: actorOf(me), teamId: me.teamId, action: "calendar_create", requestId: null,
      result: "ok", detail: `event=${eventId} ${input.startDate}`,
    });

    // Jira 는 **저장 뒤 곁다리**다. 실패해도 일정은 남는다.
    // 메모지는 syncEventToJira 가 안에서 걸러낸다(한 자리에서 판정하려고 여기서 안 나눈다).
    const jira = await syncEventToJira(db, me.teamId, eventId).catch(() => null);
    return NextResponse.json({
      ok: true,
      event: await getEvent(db, me.teamId, eventId),
      jira,
    });
  } catch (error) {
    return fail(error);
  } finally {
    await db.close();
  }
}

/**
 * 수정. 한 줄 문법으로 다시 적어도 되고(`line`), 칸 하나만 보내도 된다.
 *
 * 상태가 바뀌면 Jira 쪽 **상태 전이**까지 따라간다(lib/calendarJira.ts).
 */
export async function PATCH(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, message: "요청 본문을 읽지 못했습니다." }, { status: 400 });
  }
  const str = (key: string): string => (typeof body[key] === "string" ? (body[key] as string) : "");

  const eventId = Number(body.eventId);
  if (!Number.isInteger(eventId)) {
    return NextResponse.json({ ok: false, message: "일정 번호가 올바르지 않습니다." }, { status: 400 });
  }

  const db = await openDb();
  try {
    const me = await userFromRequestWith(db, request);
    if (me === null) return NextResponse.json(UNAUTHORIZED, { status: 401 });
    if (me.teamId === "") return NextResponse.json(NO_TEAM, { status: 400 });

    const before = await getEvent(db, me.teamId, eventId);
    if (before === null) {
      return NextResponse.json({ ok: false, message: "그 일정을 찾을 수 없습니다." }, { status: 404 });
    }

    let patch: EventPatch;
    const line = str("line").trim();
    if (line !== "") {
      const parsed = parseQuickAdd(line, str("today") || before.startDate);
      const members = (await listTeamMembers(db, me.teamId)).map((m) => ({
        userId: m.userId,
        displayName: m.displayName,
        loginId: m.loginId,
      }));
      const matched = matchAssignee(parsed.assignee, members);
      const tags = classifyTags(parsed.kinds);
      patch = {
        title: parsed.title,
        kind: tags.rest[0] ?? "",
        scopes: tags.scopes.join("/"),
        corp: tags.corp ?? "",
        // 한 줄에 날짜를 안 적었으면 **원래 날짜를 지킨다.** 기준일로 밀어 버리면
        // 제목만 고치려던 수정이 일정을 다른 날로 옮긴다.
        startDate: parsed.hadDate ? parsed.startDate : before.startDate,
        endDate: parsed.hadDate ? parsed.endDate : before.endDate,
        startTime: parsed.startTime,
        endTime: parsed.endTime,
        assigneeUserId: parsed.assignee === "" ? before.assigneeUserId : (matched?.userId ?? null),
        assigneeLabel: parsed.assignee === "" ? before.assigneeLabel : parsed.assignee,
      };
    } else {
      patch = {};
      if (typeof body.title === "string") patch = { ...patch, title: body.title };
      if (Array.isArray(body.tags)) {
        // 폼 수정. 태그를 다시 가른다 — 한 줄 수정과 같은 함수를 쓴다.
        const tags = classifyTags(
          (body.tags as unknown[]).filter((t): t is string => typeof t === "string"),
        );
        patch = {
          ...patch,
          kind: tags.rest[0] ?? "",
          scopes: tags.scopes.join("/"),
          corp: tags.corp ?? "",
        };
      } else if (typeof body.kind === "string") {
        patch = { ...patch, kind: body.kind };
      }
      if (body.assigneeUserId !== undefined) {
        const picked = Number(body.assigneeUserId);
        const ok = Number.isInteger(picked) && picked > 0;
        const member = ok
          ? (await listTeamMembers(db, me.teamId)).find((m) => m.userId === picked) ?? null
          : null;
        patch = {
          ...patch,
          assigneeUserId: member?.userId ?? null,
          assigneeLabel: member?.displayName ?? "",
        };
      }
      if (typeof body.body === "string") patch = { ...patch, body: body.body };
      if (typeof body.startDate === "string") patch = { ...patch, startDate: body.startDate };
      if (typeof body.endDate === "string") patch = { ...patch, endDate: body.endDate };
      if (typeof body.startTime === "string") patch = { ...patch, startTime: body.startTime };
      if (typeof body.endTime === "string") patch = { ...patch, endTime: body.endTime };
      if (typeof body.state === "string") patch = { ...patch, state: coerceState(body.state) };
      /*
       * 메모지 → Jira 는 **켜는 방향만** 받는다.
       *
       * 끄는 것을 받아 주면 "동기화만 멈춘 이슈" 가 Jira 에 남는다. 일정은 고쳐지는데
       * 이슈는 그대로라 둘이 조용히 어긋나고, 보는 사람은 어느 쪽이 맞는지 알 수 없다.
       * 정말 없애려면 Jira 에서 이슈를 지워야 하므로, 여기서 끊고 그렇게 말해 준다.
       */
      if (body.jiraWanted !== undefined) {
        const wanted = body.jiraWanted === true;
        if (!wanted && before.jiraKey !== "") {
          return NextResponse.json(
            {
              ok: false,
              message:
                `이미 Jira 에 올라간 일정입니다(${before.jiraKey}). 메모로 되돌리려면 Jira 에서 이슈를 먼저 지워주세요.`,
            },
            { status: 400 },
          );
        }
        patch = { ...patch, jiraWanted: wanted };
      }
    }

    const after = await updateEvent(db, me.teamId, eventId, patch);
    if (after === null) {
      return NextResponse.json({ ok: false, message: "그 일정을 찾을 수 없습니다." }, { status: 404 });
    }
    await recordAudit(db, {
      actor: actorOf(me), teamId: me.teamId, action: "calendar_update", requestId: null,
      result: "ok", detail: `event=${eventId}`,
    });

    const jira = await syncEventToJira(db, me.teamId, eventId, {
      stateChanged: before.state !== after.state,
    }).catch(() => null);

    return NextResponse.json({ ok: true, event: await getEvent(db, me.teamId, eventId), jira });
  } catch (error) {
    return fail(error);
  } finally {
    await db.close();
  }
}

/**
 * 삭제. `?eventId=` 또는 `?eventId=&noteId=`(메모만).
 *
 * **Jira 이슈도 함께 지운다.** 사용자 결정이다(계획서 S5). 지울 수 없는 환경이면
 * 대신 코멘트를 남기고, 그 사실을 응답에 담아 화면이 말하게 한다 — 조용히 넘기면
 * 캘린더에는 없고 Jira 에는 남은 일정이 생긴다.
 */
export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const eventId = Number(url.searchParams.get("eventId"));
  if (!Number.isInteger(eventId)) {
    return NextResponse.json({ ok: false, message: "일정 번호가 올바르지 않습니다." }, { status: 400 });
  }
  const noteIdRaw = url.searchParams.get("noteId");

  const db = await openDb();
  try {
    const me = await userFromRequestWith(db, request);
    if (me === null) return NextResponse.json(UNAUTHORIZED, { status: 401 });
    if (me.teamId === "") return NextResponse.json(NO_TEAM, { status: 400 });

    if (noteIdRaw !== null) {
      const noteId = Number(noteIdRaw);
      if (!Number.isInteger(noteId)) {
        return NextResponse.json({ ok: false, message: "메모 번호가 올바르지 않습니다." }, { status: 400 });
      }
      await deleteEventNote(db, me.teamId, eventId, noteId);
      return NextResponse.json({ ok: true, notes: await listEventNotes(db, me.teamId, eventId) });
    }

    // Jira 를 **먼저** 지운다. 캘린더 행이 사라지면 이슈 키를 읽을 곳이 없어진다.
    const jira = await removeEventFromJira(db, me.teamId, eventId, actorOf(me)).catch(() => null);

    const removed = await deleteEvent(db, me.teamId, eventId);
    if (!removed) {
      return NextResponse.json({ ok: false, message: "그 일정을 찾을 수 없습니다." }, { status: 404 });
    }
    await recordAudit(db, {
      actor: actorOf(me), teamId: me.teamId, action: "calendar_delete", requestId: null,
      result: "ok", detail: `event=${eventId}${jira?.issueKey ? ` jira=${jira.issueKey}` : ""}`,
    });

    return NextResponse.json({ ok: true, jira });
  } catch (error) {
    return fail(error);
  } finally {
    await db.close();
  }
}
