/**
 * 한 줄 일정 입력 파서.
 *
 * 이 파일이 한 줄 문법의 **정본**이다. 화면 미리보기와 서버 저장이 같은 함수를 쓰므로,
 * 여기서 잠근 동작이 곧 사용자가 보는 동작이다.
 *
 * 특히 조심한 것:
 *   - 기간 표기를 단일 날짜보다 **먼저** 읽는다(`11/25-11/27` 이 25일로 잘리면 안 된다).
 *   - 12월에 적은 `1/5` 는 **다음 해**다. 지난 1월로 읽으면 일정이 11개월 전으로
 *     사라지고 "저장이 안 됐다" 로 보인다.
 *   - 날짜를 Date 객체로 다루지 않는다 — 서버가 UTC 면 자정 무렵 하루가 밀린다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  daysBetween,
  daysInMonth,
  describeQuickAdd,
  formatQuickAddLine,
  isDateString,
  parseQuickAdd,
  weekdayOf,
} from "../lib/quickAdd.ts";

/** 기준일. 2026-11-20 은 금요일이다. */
const TODAY = "2026-11-20";

/* ------------------------------------------------------------------ *
 * 날짜 산수
 * ------------------------------------------------------------------ */

test("날짜 문자열 판정", () => {
  assert.ok(isDateString("2026-11-20"));
  assert.ok(isDateString("2024-02-29"), "윤년 2월 29일");
  assert.equal(isDateString("2026-02-30"), false);
  assert.equal(isDateString("2025-02-29"), false, "평년에는 없는 날");
  assert.equal(isDateString("2026-13-01"), false);
  assert.equal(isDateString("2026-11-20 "), false);
  assert.equal(isDateString("11/20"), false);
});

test("일수 더하기는 달·해를 넘어간다", () => {
  assert.equal(addDays("2026-11-20", 1), "2026-11-21");
  assert.equal(addDays("2026-11-30", 1), "2026-12-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2027-01-01", -1), "2026-12-31");
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
});

test("달의 날 수", () => {
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2026, 11), 30);
  assert.equal(daysInMonth(2026, 12), 31);
});

test("요일", () => {
  assert.equal(weekdayOf("2026-11-20"), "금");
  assert.equal(weekdayOf("2026-11-21"), "토");
  assert.equal(weekdayOf("2026-11-22"), "일");
});

test("두 날짜 사이 일수", () => {
  assert.equal(daysBetween("2026-11-20", "2026-11-22"), 2);
  assert.equal(daysBetween("2026-11-22", "2026-11-20"), -2);
  assert.equal(daysBetween("2026-11-20", "2026-11-20"), 0);
});

/* ------------------------------------------------------------------ *
 * 날짜 조각
 * ------------------------------------------------------------------ */

test("날짜를 안 적으면 선택한 날이다", () => {
  const r = parseQuickAdd("방화벽 룰 정리", TODAY);
  assert.equal(r.startDate, TODAY);
  assert.equal(r.endDate, TODAY);
  assert.equal(r.title, "방화벽 룰 정리");
  assert.equal(r.hadDate, false, "미리보기가 '날짜 안 적음' 을 말할 수 있어야 한다");
  assert.match(r.summary, /날짜 안 적음/);
});

test("오늘·내일·모레", () => {
  assert.equal(parseQuickAdd("오늘 점검", TODAY).startDate, "2026-11-20");
  assert.equal(parseQuickAdd("내일 점검", TODAY).startDate, "2026-11-21");
  assert.equal(parseQuickAdd("모레 점검", TODAY).startDate, "2026-11-22");
  assert.equal(parseQuickAdd("어제 장애 대응", TODAY).startDate, "2026-11-19");
});

test("M/D 는 그 해의 날짜다", () => {
  const r = parseQuickAdd("11/25 방화벽 점검", TODAY);
  assert.equal(r.startDate, "2026-11-25");
  assert.equal(r.endDate, "2026-11-25");
  assert.equal(r.title, "방화벽 점검");
  assert.equal(r.hadDate, true);
});

test("구분자는 / . - 를 모두 받는다", () => {
  for (const token of ["11/25", "11.25", "11-25"]) {
    assert.equal(parseQuickAdd(`${token} 점검`, TODAY).startDate, "2026-11-25", token);
  }
});

test("12월에 적은 1/5 는 다음 해다", () => {
  // 지난 1월로 읽으면 일정이 11개월 전에 꽂혀 그리드에서 사라진다.
  const r = parseQuickAdd("1/5 신년 점검", "2026-12-28");
  assert.equal(r.startDate, "2027-01-05");
});

test("조금 지난 날짜는 올해 그대로 본다", () => {
  // "지난주 금요일에 한 작업을 지금 적는" 쓰임이 실제로 많다.
  const r = parseQuickAdd("11/13 장애 기록", TODAY);
  assert.equal(r.startDate, "2026-11-13");
});

test("M/D~M/D 기간", () => {
  const r = parseQuickAdd("11/25~11/27 정기점검", TODAY);
  assert.equal(r.startDate, "2026-11-25");
  assert.equal(r.endDate, "2026-11-27");
  assert.match(r.summary, /3일간/);
});

test("하이픈 기간도 단일 날짜로 잘리지 않는다", () => {
  const r = parseQuickAdd("11/25-11/27 정기점검", TODAY);
  assert.equal(r.startDate, "2026-11-25");
  assert.equal(r.endDate, "2026-11-27", "'11-25' 로 먼저 읽히면 27이 제목에 섞인다");
  assert.equal(r.title, "정기점검");
});

test("해를 넘는 기간", () => {
  const r = parseQuickAdd("12/30~1/2 연말 작업", "2026-12-20");
  assert.equal(r.startDate, "2026-12-30");
  assert.equal(r.endDate, "2027-01-02", "끝 날짜는 시작 날짜 기준으로 풀어야 한다");
});

test("M/D~D (끝 달 생략)", () => {
  const r = parseQuickAdd("11/25~27 정기점검", TODAY);
  assert.equal(r.startDate, "2026-11-25");
  assert.equal(r.endDate, "2026-11-27");
});

test("D~D 는 이번 달이다", () => {
  const r = parseQuickAdd("25~27 정기점검 준비", TODAY);
  assert.equal(r.startDate, "2026-11-25");
  assert.equal(r.endDate, "2026-11-27");
  assert.equal(r.title, "정기점검 준비");
});

test("거꾸로 적은 기간은 바로 돌린다", () => {
  const r = parseQuickAdd("27~25 점검", TODAY);
  assert.equal(r.startDate, "2026-11-25");
  assert.equal(r.endDate, "2026-11-27");
});

test("없는 날짜는 날짜로 읽지 않고 제목에 남긴다", () => {
  // 조용히 버리면 "11/31" 이라고 적은 사람은 그 날짜로 들어갔다고 믿는다.
  const r = parseQuickAdd("11/31 점검", TODAY);
  assert.equal(r.hadDate, false);
  assert.equal(r.title, "11/31 점검");
});

test("YYYY-MM-DD 도 그대로 받는다", () => {
  const r = parseQuickAdd("2027-03-04 교육", TODAY);
  assert.equal(r.startDate, "2027-03-04");
});

/* ------------------------------------------------------------------ *
 * 시간 조각
 * ------------------------------------------------------------------ */

test("시간이 없으면 종일이다", () => {
  const r = parseQuickAdd("11/25 점검", TODAY);
  assert.equal(r.startTime, "");
  assert.equal(r.endTime, "");
  assert.match(r.summary, /종일/);
});

test("시작 시각만", () => {
  const r = parseQuickAdd("내일 14:00 회의", TODAY);
  assert.equal(r.startTime, "14:00");
  assert.equal(r.endTime, "");
  assert.equal(r.title, "회의");
});

test("시간 범위", () => {
  const r = parseQuickAdd("내일 14:00-16:00 VCF 패치", TODAY);
  assert.equal(r.startTime, "14:00");
  assert.equal(r.endTime, "16:00");
  assert.equal(r.title, "VCF 패치");
});

test("한 자리 시각도 맞춰 채운다", () => {
  const r = parseQuickAdd("9:30 조회", TODAY);
  assert.equal(r.startTime, "09:30");
});

test("있을 수 없는 시각은 시간으로 읽지 않는다", () => {
  const r = parseQuickAdd("25:00 점검", TODAY);
  assert.equal(r.startTime, "");
  assert.equal(r.title, "25:00 점검");
});

/* ------------------------------------------------------------------ *
 * 담당자 · 종류
 * ------------------------------------------------------------------ */

test("@담당자와 #종류", () => {
  const r = parseQuickAdd("11/25 방화벽 점검 @용식 #점검", TODAY);
  assert.equal(r.assignee, "용식");
  assert.equal(r.kind, "점검");
  assert.equal(r.title, "방화벽 점검");
});

test("순서는 상관없다", () => {
  const r = parseQuickAdd("#작업 @민수 내일 14:00-16:00 VCF 패치", TODAY);
  assert.equal(r.kind, "작업");
  assert.equal(r.assignee, "민수");
  assert.equal(r.startDate, "2026-11-21");
  assert.equal(r.startTime, "14:00");
  assert.equal(r.title, "VCF 패치");
});

test("태그는 여러 개를 다 받는다 — 두 번째 담당자만 제목에 남는다", () => {
  // 태그를 하나만 받던 때는 두 번째 태그가 제목으로 밀려났다. 이 팀의 Jira 제목은
  // 망을 여러 개 쓰므로(`[개발/운영/DR]`) 태그는 전부 받아야 한다.
  // 담당자는 하나뿐이라 두 번째는 그대로 제목에 남긴다(버리면 적은 사람이 모른다).
  const r = parseQuickAdd("점검 #개발 #운영 #DR @a @b", TODAY);
  assert.deepEqual(r.kinds, ["개발", "운영", "DR"]);
  assert.equal(r.kind, "개발", "첫 태그는 표시용으로 남는다");
  assert.equal(r.assignee, "a");
  assert.equal(r.title, "점검 @b");
});

test("같은 태그를 두 번 적어도 한 번만 센다", () => {
  assert.deepEqual(parseQuickAdd("점검 #운영 #운영 #운", TODAY).kinds, ["운영", "운"]);
});

test("목록에 없는 종류도 받는다", () => {
  assert.equal(parseQuickAdd("#마이그레이션 작업", TODAY).kind, "마이그레이션");
});

test("# 이나 @ 한 글자는 조각이 아니다", () => {
  const r = parseQuickAdd("# @ 제목", TODAY);
  assert.equal(r.kind, "");
  assert.equal(r.assignee, "");
  assert.equal(r.title, "# @ 제목");
});

/* ------------------------------------------------------------------ *
 * 미리보기 문구
 * ------------------------------------------------------------------ */

test("미리보기는 날짜·시간·종류·담당을 한 줄로 말한다", () => {
  const r = parseQuickAdd("11/25 방화벽 점검 @용식 #점검", TODAY);
  assert.equal(r.summary, "11/25(수) · 종일 · 점검 · 담당 용식");
});

test("미리보기가 기간과 시간 범위를 말한다", () => {
  const r = parseQuickAdd("11/25~11/27 09:00-18:00 정기점검", TODAY);
  assert.equal(r.summary, "11/25(수)~11/27(금) 3일간 · 09:00~18:00");
});

test("제목이 비면 미리보기가 경고한다", () => {
  const r = parseQuickAdd("11/25 #점검", TODAY);
  assert.equal(r.title, "");
  assert.match(r.summary, /제목이 비었습니다/);
});

test("describeQuickAdd 는 파서 결과와 같은 문장을 만든다", () => {
  const r = parseQuickAdd("내일 14:00 회의 @민수", TODAY);
  const { summary, ...rest } = r;
  assert.equal(describeQuickAdd(rest), summary, "미리보기와 저장이 어긋나면 안 된다");
});

/* ------------------------------------------------------------------ *
 * 입력 방어
 * ------------------------------------------------------------------ */

test("빈 줄도 터지지 않는다", () => {
  const r = parseQuickAdd("   ", TODAY);
  assert.equal(r.title, "");
  assert.equal(r.startDate, TODAY);
});

test("기준 날짜가 형식에 안 맞으면 던진다", () => {
  // 조용히 오늘로 떨어지면 일정이 엉뚱한 날에 꽂히고 사람은 사라진 줄 안다.
  assert.throws(() => parseQuickAdd("점검", "11/20"), /기준 날짜/);
  assert.throws(() => parseQuickAdd("점검", ""), /기준 날짜/);
});

/* ------------------------------------------------------------------ *
 * 한 줄로 되돌리기 (인라인 편집)
 * ------------------------------------------------------------------ */

test("일정을 한 줄로 되돌려 적는다", () => {
  assert.equal(
    formatQuickAddLine({
      startDate: "2026-11-25", endDate: "2026-11-25",
      startTime: "", endTime: "", title: "방화벽 점검", kinds: ["점검"], assignee: "용식",
    }),
    "2026-11-25 방화벽 점검 @용식 #점검",
  );
  assert.equal(
    formatQuickAddLine({
      startDate: "2026-11-25", endDate: "2026-11-27",
      startTime: "09:00", endTime: "18:00", title: "정기점검", kinds: [], assignee: "",
    }),
    "2026-11-25~2026-11-27 09:00-18:00 정기점검",
  );
});

test("되돌린 한 줄을 다시 읽으면 같은 일정이다 (왕복)", () => {
  // 편집이 왕복에서 값을 잃으면, 제목만 고치려던 수정이 날짜를 바꿔 버린다.
  const cases = [
    { startDate: "2026-11-25", endDate: "2026-11-25", startTime: "", endTime: "", title: "방화벽 점검", kinds: ["점검"], assignee: "용식" },
    { startDate: "2026-11-25", endDate: "2026-11-27", startTime: "09:00", endTime: "18:00", title: "정기점검 준비", kinds: ["작업"], assignee: "민수" },
    { startDate: "2027-01-02", endDate: "2027-01-02", startTime: "14:00", endTime: "", title: "신년 회의", kinds: [], assignee: "" },
    { startDate: "2026-12-30", endDate: "2027-01-02", startTime: "", endTime: "", title: "연말 작업", kinds: ["휴가"], assignee: "" },
  ];
  for (const c of cases) {
    const line = formatQuickAddLine(c);
    const back = parseQuickAdd(line, TODAY);
    assert.equal(back.startDate, c.startDate, line);
    assert.equal(back.endDate, c.endDate, line);
    assert.equal(back.startTime, c.startTime, line);
    assert.equal(back.endTime, c.endTime, line);
    assert.equal(back.title, c.title, line);
    assert.deepEqual(back.kinds, c.kinds, line);
    assert.equal(back.assignee, c.assignee, line);
    assert.equal(back.hadDate, true, line);
  }
});
