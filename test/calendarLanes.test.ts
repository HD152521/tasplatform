/**
 * 이어지는 일정이 **한 덩어리 띠**로 나오는지.
 *
 * 전에는 달력 칸마다 색점을 찍었다. 12~13일짜리 일정이 12일에 점 하나, 13일에 점
 * 하나로 보여 "이틀짜리 하나" 와 "하루짜리 둘" 을 구별할 수 없었다. 여기서 못박는 것은
 * 그 구별이다 — 기간은 **길이(span)** 로 나와야 한다.
 *
 * 그리고 쌓는 순서. 긴 일정이 주마다 다른 줄에 앉으면 선이 끊겨 보인다. 주 경계를 넘는
 * 일정이 **양쪽 주에서 같은 줄 번호**를 받는지 확인한다 — 이것이 틀려도 화면은
 * 그려지므로(조용한 실패) 눈으로는 "왜 선이 어긋나지?" 밖에 알 수 없다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hiddenPerDay, layoutWeek } from "../lib/calendarLanes.ts";

/** 2026-11-15(일) ~ 11-21(토). */
const WEEK = [
  "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18",
  "2026-11-19", "2026-11-20", "2026-11-21",
];
/** 그 다음 주, 11-22(일) ~ 11-28(토). */
const NEXT_WEEK = [
  "2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25",
  "2026-11-26", "2026-11-27", "2026-11-28",
];

function span(id: string, startDate: string, endDate: string) {
  return { id, startDate, endDate };
}

test("이틀짜리는 두 칸을 덮는 띠 하나다 — 점 두 개가 아니다", () => {
  const segments = layoutWeek([span("a", "2026-11-17", "2026-11-18")], WEEK);

  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.col, 2); // 11-17 은 세 번째 칸
  assert.equal(segments[0]?.span, 2);
  assert.equal(segments[0]?.continuesLeft, false);
  assert.equal(segments[0]?.continuesRight, false);
});

test("하루짜리도 같은 모양으로 나온다(span 1)", () => {
  const segments = layoutWeek([span("a", "2026-11-19", "2026-11-19")], WEEK);
  assert.equal(segments[0]?.span, 1);
  assert.equal(segments[0]?.col, 4);
});

test("주 밖으로 나가면 잘라 주고, 어느 쪽으로 더 가는지 알려 준다", () => {
  const long = span("a", "2026-11-11", "2026-11-25");

  const first = layoutWeek([long], WEEK)[0];
  assert.equal(first?.col, 0);
  assert.equal(first?.span, 7);
  assert.equal(first?.continuesLeft, true, "11-11 은 이 주보다 앞이다");
  assert.equal(first?.continuesRight, true, "11-25 는 이 주보다 뒤다");

  const second = layoutWeek([long], NEXT_WEEK)[0];
  assert.equal(second?.col, 0);
  assert.equal(second?.span, 4, "11-22 ~ 11-25 는 네 칸");
  assert.equal(second?.continuesLeft, true);
  assert.equal(second?.continuesRight, false, "여기서 끝난다");
});

test("긴 일정은 주가 바뀌어도 같은 줄에 앉는다 — 선이 끊겨 보이지 않게", () => {
  const items = [
    span("long", "2026-11-18", "2026-11-24"),
    // 짧은 것들이 먼저 들어와도 순서는 날짜·길이로만 정해진다.
    span("short1", "2026-11-20", "2026-11-20"),
    span("short2", "2026-11-23", "2026-11-23"),
  ];

  const laneOf = (week: readonly string[], id: string): number | undefined =>
    layoutWeek(items, week).find((seg) => seg.item.id === id)?.lane;

  assert.equal(laneOf(WEEK, "long"), laneOf(NEXT_WEEK, "long"));
});

test("겹치면 아래로 쌓이고, 안 겹치면 같은 줄을 다시 쓴다", () => {
  const segments = layoutWeek(
    [
      span("a", "2026-11-16", "2026-11-17"),
      span("b", "2026-11-16", "2026-11-16"), // a 와 겹친다 → 다음 줄
      span("c", "2026-11-19", "2026-11-20"), // 아무것과도 겹치지 않는다 → 첫 줄
    ],
    WEEK,
  );
  const lane = (id: string) => segments.find((s) => s.item.id === id)?.lane;

  assert.equal(lane("a"), 0);
  assert.equal(lane("b"), 1);
  assert.equal(lane("c"), 0, "빈 자리가 있으면 첫 줄을 다시 쓴다");
});

test("이 주와 겹치지 않는 일정은 아예 나오지 않는다", () => {
  assert.deepEqual(layoutWeek([span("a", "2026-12-01", "2026-12-02")], WEEK), []);
});

test("끝이 시작보다 앞선 깨진 자료도 하루로 보여 준다 — 조용히 지우지 않는다", () => {
  const segments = layoutWeek([span("a", "2026-11-18", "2026-11-16")], WEEK);
  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.col, 3);
  assert.equal(segments[0]?.span, 1);
});

test("가려진 띠는 덮는 날마다 한 건으로 센다", () => {
  const segments = layoutWeek(
    [
      span("a", "2026-11-16", "2026-11-18"),
      span("b", "2026-11-16", "2026-11-18"),
      // 셋째 줄로 밀린다 — 이 사흘이 각각 1건씩 가려진다.
      span("c", "2026-11-16", "2026-11-18"),
    ],
    WEEK,
  );

  assert.deepEqual(hiddenPerDay(segments, 2, 7), [0, 1, 1, 1, 0, 0, 0]);
  assert.deepEqual(hiddenPerDay(segments, 3, 7), [0, 0, 0, 0, 0, 0, 0], "다 보이면 0 이다");
});
