/**
 * 팀 캘린더의 저장·조회.
 *
 * 이 시험이 지키는 것:
 *   - 여러 날에 걸친 일정이 **걸치는 모든 달**에서 보인다. 시작일만 보면 "11/28~12/3"
 *     일정이 12월 달력에서 사라진다.
 *   - 모든 조회·수정이 **팀으로 묶인다.** id 만으로 남의 팀 일정을 고칠 수 없다.
 *   - 날짜가 깨진 저장은 거부한다. 저장은 성공했는데 어느 날짜 칸에도 안 걸리면
 *     사람은 "사라졌다" 고 본다.
 *   - 담당자를 못 맞춰도 **적어 둔 이름은 남는다.** 조용히 버리면 "@민수" 라고 쓴
 *     사람은 담당자가 들어갔다고 믿는다.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CalendarError,
  addEventNote,
  createEvent,
  deleteEvent,
  deleteEventNote,
  getEvent,
  listEventNotes,
  listEventsBetween,
  listEventsInMonth,
  matchAssignee,
  updateEvent,
} from "../lib/calendar.ts";
import { openDb, upsertTeam, type Db } from "../lib/db.ts";
import { signup } from "../lib/users.ts";

function freshDb(): Promise<Db> {
  return openDb(join(mkdtempSync(join(tmpdir(), "cal-")), "sr.db"));
}

let db: Db;
let userId: number;

beforeEach(async () => {
  db = await freshDb();
  const user = await signup(db, {
    loginId: "yongsik",
    displayName: "안용식",
    password: "hunter2hunter2",
    inviteCode: "",
  });
  userId = user.userId;
});

const baseEvent = {
  teamId: "default",
  title: "방화벽 점검",
  startDate: "2026-11-25",
};

/* ------------------------------------------------------------------ *
 * 저장
 * ------------------------------------------------------------------ */

test("일정 하나를 저장하고 되읽는다", async () => {
  const id = await createEvent(db, {
    ...baseEvent,
    kind: "점검",
    startTime: "14:00",
    endTime: "16:00",
    assigneeUserId: userId,
    assigneeLabel: "용식",
    createdBy: userId,
  });

  const event = await getEvent(db, "default", id);
  assert.ok(event !== null);
  assert.equal(event.title, "방화벽 점검");
  assert.equal(event.kind, "점검");
  assert.equal(event.startDate, "2026-11-25");
  assert.equal(event.endDate, "2026-11-25", "종료일을 안 주면 시작일과 같다");
  assert.equal(event.startTime, "14:00");
  assert.equal(event.state, "planned");
  assert.equal(event.jiraState, "none", "Jira 없이도 완결 동작해야 한다");
  assert.equal(event.assigneeUserId, userId);
});

test("날짜가 깨진 저장은 거부한다", async () => {
  await assert.rejects(() => createEvent(db, { ...baseEvent, startDate: "11/25" }), CalendarError);
  await assert.rejects(
    () => createEvent(db, { ...baseEvent, startDate: "2026-02-30" }),
    CalendarError,
  );
  await assert.rejects(
    () => createEvent(db, { ...baseEvent, endDate: "2026-11-24" }),
    /종료 날짜가 시작 날짜보다 앞/,
  );
});

test("시각 형식이 틀리면 거부한다", async () => {
  await assert.rejects(() => createEvent(db, { ...baseEvent, startTime: "25:00" }), CalendarError);
  await assert.rejects(() => createEvent(db, { ...baseEvent, startTime: "2시" }), CalendarError);
  // 빈 시각은 "종일" 이라는 뜻이라 통과해야 한다.
  await createEvent(db, { ...baseEvent, startTime: "", endTime: "" });
});

test("제목이 비면 거부한다", async () => {
  await assert.rejects(() => createEvent(db, { ...baseEvent, title: "   " }), CalendarError);
});

/* ------------------------------------------------------------------ *
 * 조회 — 걸치는 기간
 * ------------------------------------------------------------------ */

test("여러 날에 걸친 일정이 걸치는 달 양쪽에서 보인다", async () => {
  await createEvent(db, {
    teamId: "default",
    title: "연말 작업",
    startDate: "2026-11-28",
    endDate: "2026-12-03",
  });

  const november = await listEventsInMonth(db, "default", "2026-11");
  const december = await listEventsInMonth(db, "default", "2026-12");
  assert.equal(november.length, 1, "시작한 달에서 보여야 한다");
  assert.equal(december.length, 1, "끝나는 달에서도 보여야 한다 — 시작일만 보면 사라진다");

  const october = await listEventsInMonth(db, "default", "2026-10");
  assert.equal(october.length, 0);
});

test("기간 조회는 걸치기만 해도 잡는다", async () => {
  await createEvent(db, {
    teamId: "default",
    title: "긴 작업",
    startDate: "2026-11-01",
    endDate: "2026-11-30",
  });
  // 일정 안쪽의 한 날만 물어도 나와야 한다.
  const mid = await listEventsBetween(db, "default", "2026-11-15", "2026-11-15");
  assert.equal(mid.length, 1);
});

test("조회 정렬은 날짜 → 종일 먼저 → 시각 순이다", async () => {
  await createEvent(db, { teamId: "default", title: "오후", startDate: "2026-11-25", startTime: "15:00" });
  await createEvent(db, { teamId: "default", title: "종일", startDate: "2026-11-25" });
  await createEvent(db, { teamId: "default", title: "오전", startDate: "2026-11-25", startTime: "09:00" });
  await createEvent(db, { teamId: "default", title: "다음날", startDate: "2026-11-26" });

  const list = await listEventsInMonth(db, "default", "2026-11");
  assert.deepEqual(list.map((e) => e.title), ["종일", "오전", "오후", "다음날"]);
});

test("달 형식이 틀리면 던진다", async () => {
  await assert.rejects(() => listEventsInMonth(db, "default", "2026-13"), CalendarError);
  await assert.rejects(() => listEventsInMonth(db, "default", "2026/11"), CalendarError);
});

test("12월 조회가 해를 넘겨 새지 않는다", async () => {
  await createEvent(db, { teamId: "default", title: "12월 말", startDate: "2026-12-31" });
  await createEvent(db, { teamId: "default", title: "1월 초", startDate: "2027-01-02" });
  const december = await listEventsInMonth(db, "default", "2026-12");
  assert.deepEqual(december.map((e) => e.title), ["12월 말"]);
});

/* ------------------------------------------------------------------ *
 * 팀 경계
 * ------------------------------------------------------------------ */

test("다른 팀 일정은 보이지 않고 고칠 수도 없다", async () => {
  await upsertTeam(db, { team_id: "other", team_name: "다른 팀", broadcom_username: "" });
  const mine = await createEvent(db, { ...baseEvent, title: "우리 일정" });
  await createEvent(db, { teamId: "other", title: "남의 일정", startDate: "2026-11-25" });

  const list = await listEventsInMonth(db, "default", "2026-11");
  assert.deepEqual(list.map((e) => e.title), ["우리 일정"]);

  // 남의 팀에서 내 일정을 id 로 고칠 수 없다.
  assert.equal(await updateEvent(db, "other", mine, { title: "가로채기" }), null);
  assert.equal((await getEvent(db, "default", mine))?.title, "우리 일정");
  assert.equal(await deleteEvent(db, "other", mine), false);
  assert.ok((await getEvent(db, "default", mine)) !== null);
});

test("잘못된 팀 id 는 거부한다", async () => {
  await assert.rejects(() => createEvent(db, { ...baseEvent, teamId: "../../etc" }), /잘못된 팀 id/);
});

/* ------------------------------------------------------------------ *
 * 수정 · 삭제
 * ------------------------------------------------------------------ */

test("일부만 고치면 나머지는 그대로다", async () => {
  const id = await createEvent(db, {
    ...baseEvent,
    kind: "점검",
    startTime: "14:00",
    endTime: "16:00",
    assigneeUserId: userId,
    assigneeLabel: "용식",
  });

  const after = await updateEvent(db, "default", id, { title: "방화벽 룰 정리" });
  assert.ok(after !== null);
  assert.equal(after.title, "방화벽 룰 정리");
  assert.equal(after.kind, "점검", "안 건드린 칸은 유지돼야 한다");
  assert.equal(after.startTime, "14:00");
  assert.equal(after.assigneeUserId, userId);
});

test("상태를 바꿀 수 있다 — 취소는 삭제와 다르다", async () => {
  const id = await createEvent(db, baseEvent);
  const canceled = await updateEvent(db, "default", id, { state: "canceled" });
  assert.equal(canceled?.state, "canceled");
  // 취소된 일정도 **남아 있다.** "하기로 했는데 안 했다" 는 기록이다.
  assert.equal((await listEventsInMonth(db, "default", "2026-11")).length, 1);
});

test("담당자를 비우는 수정이 된다", async () => {
  const id = await createEvent(db, { ...baseEvent, assigneeUserId: userId, assigneeLabel: "용식" });
  const after = await updateEvent(db, "default", id, { assigneeUserId: null, assigneeLabel: "" });
  assert.equal(after?.assigneeUserId, null);
  assert.equal(after?.assigneeLabel, "");
});

test("없는 일정 수정·삭제는 null/false 다", async () => {
  assert.equal(await updateEvent(db, "default", 9999, { title: "x" }), null);
  assert.equal(await deleteEvent(db, "default", 9999), false);
});

test("일정을 지우면 메모도 함께 사라진다", async () => {
  const id = await createEvent(db, baseEvent);
  await addEventNote(db, "default", id, { userId, author: "안용식", body: "룰 20개 정리" });
  assert.equal((await listEventNotes(db, "default", id)).length, 1);

  await deleteEvent(db, "default", id);
  const left = await db.all("SELECT * FROM event_notes WHERE event_id = ?", [id]);
  assert.equal(left.length, 0, "주인 없는 메모가 남으면 안 된다");
});

/* ------------------------------------------------------------------ *
 * 메모
 * ------------------------------------------------------------------ */

test("메모는 작성자를 글자로도 남긴다", async () => {
  const id = await createEvent(db, baseEvent);
  await addEventNote(db, "default", id, { userId, author: "안용식", body: "  룰 20개 정리  " });

  const notes = await listEventNotes(db, "default", id);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.body, "룰 20개 정리", "앞뒤 공백은 떼고 저장한다");
  assert.equal(notes[0]?.author, "안용식");
  assert.equal(notes[0]?.userId, userId);

  // 계정이 사라져도 "누가 적었는지" 는 남아야 한다 — 주간 정리가 이 값으로 갈라진다.
  await db.run("DELETE FROM users WHERE user_id = ?", [userId]);
  assert.equal((await listEventNotes(db, "default", id))[0]?.author, "안용식");
});

test("빈 메모와 없는 일정의 메모는 거부한다", async () => {
  const id = await createEvent(db, baseEvent);
  await assert.rejects(
    () => addEventNote(db, "default", id, { userId, author: "a", body: "   " }),
    CalendarError,
  );
  await assert.rejects(
    () => addEventNote(db, "default", 9999, { userId, author: "a", body: "x" }),
    CalendarError,
  );
  // 다른 팀에서 메모를 달 수도 없다.
  await upsertTeam(db, { team_id: "other", team_name: "다른 팀", broadcom_username: "" });
  await assert.rejects(
    () => addEventNote(db, "other", id, { userId, author: "a", body: "x" }),
    CalendarError,
  );
});

test("메모 하나만 지울 수 있다", async () => {
  const id = await createEvent(db, baseEvent);
  const noteId = await addEventNote(db, "default", id, { userId, author: "a", body: "첫 메모" });
  await addEventNote(db, "default", id, { userId, author: "a", body: "둘째 메모" });

  assert.equal(await deleteEventNote(db, "default", id, noteId), true);
  assert.deepEqual((await listEventNotes(db, "default", id)).map((n) => n.body), ["둘째 메모"]);
});

test("메모 건수가 목록에 실려 온다", async () => {
  const id = await createEvent(db, baseEvent);
  await addEventNote(db, "default", id, { userId, author: "a", body: "하나" });
  await addEventNote(db, "default", id, { userId, author: "a", body: "둘" });

  const list = await listEventsInMonth(db, "default", "2026-11");
  assert.equal(list[0]?.noteCount, 2);
});

/* ------------------------------------------------------------------ *
 * 담당자 이름 맞추기
 * ------------------------------------------------------------------ */

const MEMBERS = [
  { userId: 1, displayName: "안용식", loginId: "yongsik" },
  { userId: 2, displayName: "김민수", loginId: "minsu" },
  { userId: 3, displayName: "박민수", loginId: "parkms" },
];

test("이름·아이디 완전일치로 맞춘다", () => {
  assert.equal(matchAssignee("안용식", MEMBERS)?.userId, 1);
  assert.equal(matchAssignee("yongsik", MEMBERS)?.userId, 1);
  assert.equal(matchAssignee("YongSik", MEMBERS)?.userId, 1, "대소문자는 무시한다");
});

test("성을 떼고 불러도 맞춘다", () => {
  // 한국 이름은 성을 떼고 부르는 일이 많다.
  assert.equal(matchAssignee("용식", MEMBERS)?.userId, 1);
});

test("여럿이 걸리면 맞추지 않는다", () => {
  // 엉뚱한 사람에게 일을 배정하는 것이 담당자가 비는 것보다 나쁘다.
  assert.equal(matchAssignee("민수", MEMBERS), null);
});

test("아무도 안 걸리면 null", () => {
  assert.equal(matchAssignee("없는사람", MEMBERS), null);
  assert.equal(matchAssignee("", MEMBERS), null);
  assert.equal(matchAssignee("  ", MEMBERS), null);
});

test("못 맞춘 담당자 이름은 일정에 글자로 남는다", async () => {
  const id = await createEvent(db, { ...baseEvent, assigneeUserId: null, assigneeLabel: "민수" });
  const event = await getEvent(db, "default", id);
  assert.equal(event?.assigneeUserId, null);
  assert.equal(event?.assigneeLabel, "민수");

  // 목록에서는 그 글자가 담당자 이름 자리에 온다 — 빈칸으로 두면 적은 사람이 모른다.
  const list = await listEventsInMonth(db, "default", "2026-11");
  assert.equal(list[0]?.assigneeName, "민수");
});

test("맞춘 담당자는 지금의 이름으로 보인다", async () => {
  const id = await createEvent(db, { ...baseEvent, assigneeUserId: userId, assigneeLabel: "용식" });
  await db.run("UPDATE users SET display_name = ? WHERE user_id = ?", ["안용식(팀장)", userId]);

  const list = await listEventsInMonth(db, "default", "2026-11");
  assert.equal(
    list[0]?.assigneeName,
    "안용식(팀장)",
    "옛 이름이 남아 있으면 주간 정리에서 두 사람처럼 보인다",
  );
  assert.equal((await getEvent(db, "default", id))?.assigneeLabel, "용식");
});
