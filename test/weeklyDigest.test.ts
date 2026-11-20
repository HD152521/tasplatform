/**
 * 주간 자동 정리.
 *
 * 이 시험이 지키는 것:
 *   - **LLM 이 없거나 실패해도 정리가 나온다.** 이게 깨지면 LLM 장애 때마다
 *     "정리가 아예 없는 주" 가 생긴다.
 *   - **사람별로 갈라진다.** 그게 이 기능의 목적("누가 무엇을 했나")이다.
 *   - **같은 주를 다시 만들어도 쌓이지 않는다.**
 *   - 주 경계가 월요일이다. 일요일 하루만 다음 주로 떨어지면 금요일에 만든 정리가
 *     다음 주 것처럼 보인다.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addEventNote, createEvent, updateEvent } from "../lib/calendar.ts";
import { openDb, type Db } from "../lib/db.ts";
import { signup } from "../lib/users.ts";
import {
  autoBuildLastWeek,
  buildWeeklyDigest,
  collectDigestInput,
  describeWeek,
  getWeeklyDigest,
  listWeeklyDigests,
  recentWeeks,
  ruleBasedDigest,
  weekMondayOf,
  weekRange,
  weeksAgo,
} from "../lib/weeklyDigest.ts";

function freshDb(): Promise<Db> {
  return openDb(join(mkdtempSync(join(tmpdir(), "digest-")), "sr.db"));
}

let db: Db;
let userId: number;

/** 2026-11-23 은 월요일, 11-29 는 일요일. */
const MONDAY = "2026-11-23";
const SUNDAY = "2026-11-29";

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

/* ------------------------------------------------------------------ *
 * 주 경계
 * ------------------------------------------------------------------ */

test("주의 시작은 월요일이다", () => {
  assert.equal(weekMondayOf(MONDAY), MONDAY);
  assert.equal(weekMondayOf("2026-11-25"), MONDAY, "수요일 → 그 주 월요일");
  assert.equal(weekMondayOf("2026-11-27"), MONDAY, "금요일 → 그 주 월요일");
});

test("일요일은 지난 월요일에 붙는다", () => {
  // 일요일 하루만 다음 주가 되면, 금요일에 만든 정리가 다음 주 것처럼 보인다.
  assert.equal(weekMondayOf(SUNDAY), MONDAY);
});

test("주 범위는 월~일 7일이다", () => {
  assert.deepEqual(weekRange("2026-11-25"), { from: MONDAY, to: SUNDAY });
});

test("주 표기", () => {
  assert.equal(describeWeek(MONDAY), "11/23(월)~11/29(일)");
});

test("최근 주 목록은 최신부터다", () => {
  const weeks = recentWeeks("2026-11-25", 3);
  assert.deepEqual(weeks, [MONDAY, "2026-11-16", "2026-11-09"]);
  assert.equal(weeksAgo("2026-11-25", "2026-11-09"), 2);
});

test("날짜 형식이 틀리면 던진다", () => {
  assert.throws(() => weekMondayOf("11/23"), /형식/);
});

/* ------------------------------------------------------------------ *
 * 규칙 기반 정리
 * ------------------------------------------------------------------ */

async function seedWeek(): Promise<void> {
  const mine = await createEvent(db, {
    teamId: "default",
    title: "방화벽 점검",
    kind: "점검",
    startDate: "2026-11-24",
    assigneeUserId: userId,
    assigneeLabel: "용식",
    createdBy: userId,
  });
  await addEventNote(db, "default", mine, {
    userId,
    author: "안용식",
    body: "룰 20개 정리, 2건 삭제",
  });
  await updateEvent(db, "default", mine, { state: "done" });

  // 팀원과 맞추지 못한 담당자.
  await createEvent(db, {
    teamId: "default",
    title: "VCF 패치",
    kind: "작업",
    startDate: "2026-11-26",
    endDate: "2026-11-27",
    startTime: "14:00",
    endTime: "16:00",
    assigneeUserId: null,
    assigneeLabel: "민수",
  });

  // 담당자가 아예 없는 일정.
  await createEvent(db, {
    teamId: "default",
    title: "월말 보고 준비",
    startDate: "2026-11-27",
  });
}

test("정리는 사람별로 갈라진다", async () => {
  await seedWeek();
  const input = await collectDigestInput(db, "default", MONDAY);
  const text = ruleBasedDigest(input);

  assert.match(text, /## 사람별/);
  assert.match(text, /### 안용식 \(1건\)/);
  assert.match(text, /### 민수 \(1건\)/);
  assert.match(text, /### 담당 미지정 \(1건\)/);

  // 담당 미지정은 맨 뒤여야 한다 — 사람 이름 사이에 섞이면 목록이 읽히지 않는다.
  assert.ok(
    text.indexOf("### 담당 미지정") > text.indexOf("### 민수"),
    "담당 미지정이 사람 이름 사이에 끼면 안 된다",
  );
});

test("메모 내용이 그 일정 아래에 들어간다", async () => {
  await seedWeek();
  const text = ruleBasedDigest(await collectDigestInput(db, "default", MONDAY));
  assert.match(text, /룰 20개 정리, 2건 삭제/);
});

test("집계가 상태·종류별로 나온다", async () => {
  await seedWeek();
  const text = ruleBasedDigest(await collectDigestInput(db, "default", MONDAY));
  assert.match(text, /일정 3건/);
  assert.match(text, /완료 1/);
  assert.match(text, /예정 2/);
  assert.match(text, /점검 1/);
  assert.match(text, /작업 1/);
  assert.match(text, /기타 1/, "종류를 안 적은 일정은 '기타' 로 센다");
  assert.match(text, /작업 메모 1건/);
});

test("미완료는 '다음 주로 넘어가는 것' 에 모인다", async () => {
  await seedWeek();
  const text = ruleBasedDigest(await collectDigestInput(db, "default", MONDAY));
  const section = text.slice(text.indexOf("## 다음 주로 넘어가는 것"));
  assert.match(section, /\(2건\)/);
  assert.match(section, /VCF 패치/);
  assert.match(section, /월말 보고 준비/);
  assert.ok(!section.includes("방화벽 점검"), "완료된 일정은 이월되지 않는다");
});

test("일정이 없으면 그렇다고 말한다", async () => {
  const text = ruleBasedDigest(await collectDigestInput(db, "default", MONDAY));
  assert.match(text, /등록된 일정이 없습니다/);
});

test("규칙 기반 정리는 같은 입력에 같은 글이다", async () => {
  await seedWeek();
  const input = await collectDigestInput(db, "default", MONDAY);
  assert.equal(ruleBasedDigest(input), ruleBasedDigest(input));
});

test("그 주에 걸치는 일정만 모은다", async () => {
  await createEvent(db, { teamId: "default", title: "이번 주", startDate: "2026-11-25" });
  await createEvent(db, { teamId: "default", title: "지난 주", startDate: "2026-11-18" });
  await createEvent(db, {
    teamId: "default",
    title: "걸쳐 있음",
    startDate: "2026-11-20",
    endDate: "2026-11-24",
  });

  const input = await collectDigestInput(db, "default", MONDAY);
  assert.deepEqual(
    input.events.map((e) => e.title).sort(),
    ["걸쳐 있음", "이번 주"],
    "걸치기만 해도 들어와야 한다",
  );
});

/* ------------------------------------------------------------------ *
 * LLM — 있어도 없어도
 * ------------------------------------------------------------------ */

test("LLM 이 다듬으면 그 글을 저장한다", async () => {
  await seedWeek();
  let sawRuleText = "";
  const digest = await buildWeeklyDigest(db, "default", MONDAY, {
    actor: "안용식(yongsik)",
    chat: async (_system, user) => {
      sawRuleText = user;
      return "## 사람별\n### 안용식\n- 방화벽 룰 20개 정리 완료\n\n## 다음 주\n- VCF 패치";
    },
  });

  assert.equal(digest.source, "llm");
  assert.match(digest.body, /방화벽 룰 20개 정리 완료/);
  assert.match(sawRuleText, /### 안용식/, "LLM 에 규칙 기반 글을 재료로 준다");
  assert.equal(digest.createdBy, "안용식(yongsik)");
});

test("LLM 이 실패해도 정리는 나온다", async () => {
  await seedWeek();
  const digest = await buildWeeklyDigest(db, "default", MONDAY, {
    chat: () => Promise.reject(new Error("fetch failed")),
  });

  assert.equal(digest.source, "rule", "화면이 '집계 기반' 임을 알려 줄 수 있어야 한다");
  assert.match(digest.body, /### 안용식/);
  assert.ok(!digest.body.includes("fetch failed"), "실패 사유를 문서에 섞지 않는다");
});

test("LLM 이 빈 글·너무 짧은 글을 주면 쓰지 않는다", async () => {
  await seedWeek();
  for (const reply of ["", "   ", "정리 완료."]) {
    const digest = await buildWeeklyDigest(db, "default", MONDAY, {
      chat: () => Promise.resolve(reply),
    });
    assert.equal(digest.source, "rule", `응답: ${JSON.stringify(reply)}`);
    assert.match(digest.body, /## 사람별/);
  }
});

test("집계만 요청하면 LLM 을 부르지 않는다", async () => {
  await seedWeek();
  let called = false;
  const digest = await buildWeeklyDigest(db, "default", MONDAY, {
    ruleOnly: true,
    chat: () => {
      called = true;
      return Promise.resolve("x".repeat(100));
    },
  });
  assert.equal(called, false);
  assert.equal(digest.source, "rule");
});

test("일정이 없는 주는 LLM 을 부르지 않는다", async () => {
  let called = false;
  const digest = await buildWeeklyDigest(db, "default", MONDAY, {
    chat: () => {
      called = true;
      return Promise.resolve("x".repeat(100));
    },
  });
  assert.equal(called, false, "빈 주에 LLM 을 때릴 이유가 없다");
  assert.equal(digest.source, "rule");
});

/* ------------------------------------------------------------------ *
 * 저장
 * ------------------------------------------------------------------ */

test("같은 주를 다시 만들어도 쌓이지 않는다", async () => {
  await seedWeek();
  await buildWeeklyDigest(db, "default", MONDAY, { ruleOnly: true });
  await buildWeeklyDigest(db, "default", MONDAY, {
    chat: () =>
      Promise.resolve(
        "## 사람별\n### 안용식 (1건)\n- 11/24 방화벽 점검 완료 — 룰 20개 정리\n\n## 다음 주로 넘어가는 것\n- VCF 패치\n\n두 번째로 만든 정리입니다.",
      ),
  });

  const rows = await db.all("SELECT * FROM weekly_digests");
  assert.equal(rows.length, 1, "덮어써야 한다");

  const saved = await getWeeklyDigest(db, "default", MONDAY);
  assert.equal(saved?.source, "llm", "나중에 만든 것이 남는다");
  assert.match(saved?.body ?? "", /두 번째로 만든 정리/);
});

test("주 가운데 날짜로 물어도 그 주의 정리를 찾는다", async () => {
  await seedWeek();
  await buildWeeklyDigest(db, "default", "2026-11-26", { ruleOnly: true });
  assert.ok((await getWeeklyDigest(db, "default", MONDAY)) !== null);
  assert.ok((await getWeeklyDigest(db, "default", SUNDAY)) !== null);
});

test("목록은 최근 주부터다", async () => {
  await createEvent(db, { teamId: "default", title: "a", startDate: "2026-11-25" });
  await createEvent(db, { teamId: "default", title: "b", startDate: "2026-11-18" });
  await buildWeeklyDigest(db, "default", MONDAY, { ruleOnly: true });
  await buildWeeklyDigest(db, "default", "2026-11-16", { ruleOnly: true });

  const list = await listWeeklyDigests(db, "default");
  assert.deepEqual(list.map((d) => d.week), [MONDAY, "2026-11-16"]);
});

/* ------------------------------------------------------------------ *
 * 자동 실행
 * ------------------------------------------------------------------ */

test("지난 주 정리가 없으면 한 번 만든다", async () => {
  await seedWeek();
  // 이번 주(11/30~)에서 보면 지난 주가 11/23 이다.
  const made = await autoBuildLastWeek(db, "default", "2026-12-02");
  assert.ok(made !== null);
  assert.equal(made.week, MONDAY);

  // 두 번째 호출은 아무것도 하지 않는다 — 한 주에 한 번만 LLM 을 때린다.
  assert.equal(await autoBuildLastWeek(db, "default", "2026-12-03"), null);
});

test("지난 주에 일정이 없으면 빈 정리를 만들지 않는다", async () => {
  const made = await autoBuildLastWeek(db, "default", "2026-12-02");
  assert.equal(made, null);
  assert.equal((await listWeeklyDigests(db, "default")).length, 0);
});

test("이미 그 주 정리가 있으면 덮어쓰지 않는다", async () => {
  await seedWeek();
  await buildWeeklyDigest(db, "default", MONDAY, { ruleOnly: true, actor: "사람이 만듦" });

  assert.equal(await autoBuildLastWeek(db, "default", "2026-12-02"), null);
  assert.equal((await getWeeklyDigest(db, "default", MONDAY))?.createdBy, "사람이 만듦");
});

test("팀이 섞이지 않는다", async () => {
  await seedWeek();
  await buildWeeklyDigest(db, "default", MONDAY, { ruleOnly: true });
  assert.equal(await getWeeklyDigest(db, "other", MONDAY), null);
  assert.equal((await listWeeklyDigests(db, "other")).length, 0);
});
