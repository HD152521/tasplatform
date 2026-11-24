/**
 * 메모장 저장·조회.
 *
 * 지키는 것:
 *   1. **팀 밖으로 새지 않는다.** 모든 조회·수정이 teamId 를 조건에 함께 넣는다.
 *      이 레포에서 그 틈이 팀 혼입의 뿌리였다.
 *   2. **고친 순서**로 보인다. 메모장은 "방금 손댄 것" 을 먼저 보는 자리다.
 *   3. 제목은 받는다. 제목이 없으면 목록에서 무엇인지 알 수 없다.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb, type Db } from "../lib/db.ts";
import {
  NoteError,
  createNote,
  deleteNote,
  getNote,
  listNotes,
  updateNote,
} from "../lib/notes.ts";
import { signup } from "../lib/users.ts";

let db: Db;
let userId: number;

beforeEach(async () => {
  db = await openDb(join(mkdtempSync(join(tmpdir(), "notes-crud-")), "sr.db"));
  const user = await signup(db, {
    loginId: "yongsik",
    displayName: "안용식",
    password: "hunter2hunter2",
    inviteCode: "",
  });
  userId = user.userId;
});

afterEach(() => {
  db.close();
});

test("제목만 있으면 저장된다 — 적어 두고 나중에 채우는 쓰임이 있다", async () => {
  const id = await createNote(db, { teamId: "default", title: "나중에 정리", createdBy: userId });
  const note = await getNote(db, "default", id);
  assert.equal(note?.title, "나중에 정리");
  assert.equal(note?.body, "");
  assert.equal(note?.notionState, "none");
});

test("제목이 비면 거절한다", async () => {
  await assert.rejects(
    () => createNote(db, { teamId: "default", title: "   " }),
    (error: unknown) => error instanceof NoteError,
  );
});

test("고쳐도 제목을 비울 수 없다", async () => {
  const id = await createNote(db, { teamId: "default", title: "제목" });
  await assert.rejects(
    () => updateNote(db, "default", id, { title: "" }),
    (error: unknown) => error instanceof NoteError,
  );
});

test("남의 팀 메모는 보이지도 고쳐지지도 않는다", async () => {
  const id = await createNote(db, { teamId: "default", title: "우리 팀 메모" });

  // id 를 알아도 팀이 다르면 없는 것과 같아야 한다.
  assert.equal(await getNote(db, "other", id), null);
  assert.equal(await updateNote(db, "other", id, { title: "바꿔치기" }), null);
  assert.equal(await deleteNote(db, "other", id), null);
  assert.equal((await getNote(db, "default", id))?.title, "우리 팀 메모");
});

test("목록은 고친 순서다 — 만든 순서가 아니다", async () => {
  const first = await createNote(db, { teamId: "default", title: "먼저 적은 것" });
  const second = await createNote(db, { teamId: "default", title: "나중에 적은 것" });
  // 먼저 적은 것을 다시 고치면 그것이 맨 위로 와야 한다.
  await new Promise((done) => setTimeout(done, 5));
  await updateNote(db, "default", first, { body: "덧붙임" });

  const titles = (await listNotes(db, "default")).map((n) => n.noteId);
  assert.deepEqual(titles, [first, second]);
});

test("제목·내용·태그를 함께 찾는다", async () => {
  await createNote(db, { teamId: "default", title: "점검 메모", body: "stemcell 올림", tags: "TAS" });
  await createNote(db, { teamId: "default", title: "회의", body: "다음주 일정", tags: "회의록" });

  assert.equal((await listNotes(db, "default", { query: "stemcell" })).length, 1);
  assert.equal((await listNotes(db, "default", { query: "회의록" })).length, 1);
  assert.equal((await listNotes(db, "default", { query: "없는말" })).length, 0);
});

test("목록이 작성자 이름을 함께 준다", async () => {
  await createNote(db, { teamId: "default", title: "메모", createdBy: userId });
  assert.equal((await listNotes(db, "default"))[0]?.createdByName, "안용식");
});

test("지우면 지워진 메모를 돌려준다 — 노션 페이지가 남았는지 알려줘야 한다", async () => {
  const id = await createNote(db, { teamId: "default", title: "지울 메모" });
  const removed = await deleteNote(db, "default", id);
  assert.equal(removed?.title, "지울 메모");
  assert.equal(await getNote(db, "default", id), null);
});
