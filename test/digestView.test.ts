/**
 * 주간 정리를 화면 모양으로 확정하는 경계.
 *
 * 이 자리에서 **대시보드를 두 번 통째로 날렸다.** 서버가 보낸 JSON 의 모양이 화면이
 * 기대한 것과 어긋났고, 터지는 곳이 카드 한가운데라 페이지 전체가 "Application error"
 * 가 됐다. 정리가 없는 동안은 멀쩡했으니 가장 찾기 어려운 모양이었다.
 *
 * 그래서 여기서 잠근다 — **무엇이 들어와도 던지지 않는다.**
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { asDigestView, stampText } from "../lib/digestView.ts";

test("제대로 된 정리를 그대로 통과시킨다", () => {
  const view = asDigestView({
    team_id: "default",
    week: "2026-11-16",
    body: "## 안용식\n- 점검 완료",
    source: "llm",
    createdAt: "2026-11-23T09:00:00.000Z",
  });
  assert.equal(view?.week, "2026-11-16");
  assert.equal(view?.source, "llm");
  assert.deepEqual(view?.lines, ["## 안용식", "- 점검 완료"]);
});

test("없는 정리는 null 이다 — '아직 없다' 와 '비었다' 는 다르다", () => {
  // null 이면 화면이 "지금 만들기" 를 보여 준다. 둘을 합치면 눌러도 아무 일이
  // 없어 고장처럼 보인다.
  assert.equal(asDigestView(null), null);
  assert.equal(asDigestView(undefined), null);
  assert.equal(asDigestView("문자열"), null);
  assert.equal(asDigestView(42), null);
});

test("본문이 없거나 문자열이 아니어도 던지지 않는다", () => {
  // 이게 그 사고였다 — `undefined.split()`.
  for (const bad of [undefined, null, 0, {}, []]) {
    const view = asDigestView({ week: "2026-11-16", body: bad, createdAt: "2026-11-23T09:00" });
    assert.deepEqual(view?.lines, [], JSON.stringify(bad));
    assert.equal(view?.body, "");
  }
});

test("빈 본문은 빈 줄 하나가 아니라 빈 목록이다", () => {
  // "".split("\n") 은 [""] 라서 빈 줄 하나가 생기고, "전문 보기 (1줄)" 이 뜬다.
  assert.deepEqual(asDigestView({ body: "" })?.lines, []);
});

test("만든 시각이 없어도 카드는 산다", () => {
  const view = asDigestView({ week: "2026-11-16", body: "내용" });
  assert.equal(view?.createdAt, "");
  assert.equal(stampText(""), "");
});

test("snake_case 와 camelCase 를 둘 다 받는다", () => {
  // 서버가 toDigest 를 거치면 createdAt, 행을 그대로 보내면 created_at 이다.
  assert.equal(asDigestView({ created_at: "2026-11-23T09:00:00Z" })?.createdAt, "2026-11-23T09:00:00Z");
  assert.equal(asDigestView({ createdAt: "2026-11-23T09:00:00Z" })?.createdAt, "2026-11-23T09:00:00Z");
});

test("source 는 llm 이 아니면 rule 이다 — 모르는 값을 llm 으로 보여 주지 않는다", () => {
  assert.equal(asDigestView({ source: "llm" })?.source, "llm");
  assert.equal(asDigestView({ source: "rule" })?.source, "rule");
  assert.equal(asDigestView({ source: "gpt-5" })?.source, "rule");
  assert.equal(asDigestView({})?.source, "rule");
});

test("시각은 분까지 보여 준다", () => {
  assert.equal(stampText("2026-11-23T09:00:00.000Z"), "2026-11-23 09:00");
});

test("짧은 시각은 자르지 않고 그대로 둔다", () => {
  // 자르면 "2026-11-2" 처럼 틀린 날짜가 보인다. 아는 만큼만 보여 주는 쪽이 맞다.
  assert.equal(stampText("2026-11-23"), "2026-11-23");
});
