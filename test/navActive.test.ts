/**
 * 좌측 메뉴의 "지금 여기" 표시.
 *
 * 전에는 화면에서 `path.startsWith(href)` 로 판단해, `/settings/llm` 에서 `/settings`
 * 까지 같이 켜졌다. **두 항목이 켜져 있으면 지금 어디에 있는지 알 수 없다.**
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { activeNavHref } from "../lib/navActive.ts";

/** 실제 메뉴와 같은 순서. `/settings` 가 `/settings/llm` 의 앞자리라 겹친다. */
const HREFS = [
  "/", "/closed", "/new", "/cves", "/kb", "/report", "/logs", "/settings", "/settings/llm",
];

test("각 항목에 있으면 그 항목만 켜진다", () => {
  for (const href of HREFS) {
    assert.equal(activeNavHref(href, HREFS), href, `${href} 에서 틀렸다`);
  }
});

/*
 * **이 파일이 있는 이유.** `/settings/llm` 에서는 LLM 연결만 켜져야 한다.
 * 앞자리가 겹치는 `/settings` 가 같이 켜지면 안 된다.
 */
test("하위 경로에서는 더 깊은 항목만 켜진다", () => {
  assert.equal(activeNavHref("/settings/llm", HREFS), "/settings/llm");
  // 순서를 뒤집어도 같아야 한다 — 목록 순서에 기대지 않는다.
  assert.equal(activeNavHref("/settings/llm", [...HREFS].reverse()), "/settings/llm");
});

test("메뉴에 없는 하위 경로는 가장 가까운 상위 항목이 켜진다", () => {
  assert.equal(activeNavHref("/settings/llm/extra", HREFS), "/settings/llm");
  assert.equal(activeNavHref("/report/photos", HREFS), "/report");
});

/*
 * `/` 는 **정확히 일치할 때만** 켠다. 접두어로 보면 모든 경로가 걸려 늘 켜져 있다.
 */
test("홈은 정확히 홈일 때만 켜진다", () => {
  assert.equal(activeNavHref("/", HREFS), "/");
  assert.equal(activeNavHref("/closed", HREFS), "/closed");
  assert.equal(activeNavHref("/cases/123", HREFS), null, "케이스 상세에서는 홈이 켜지면 안 된다");
});

/*
 * 맞는 것이 없으면 null. 메뉴에 없는 화면에서 **엉뚱한 곳이 켜져 있는 것보다** 낫다.
 */
test("맞는 항목이 없으면 null 이다", () => {
  assert.equal(activeNavHref("/cases/37027473", HREFS), null);
  assert.equal(activeNavHref("/login", HREFS), null);
  assert.equal(activeNavHref("/", []), null);
});

// 앞자리가 같아도 경로 구분자로 끊어 본다. `/settings` 가 `/settingsx` 를 먹으면 안 된다.
test("경로 구분자로 끊어 본다", () => {
  assert.equal(activeNavHref("/settingsx", HREFS), null);
  assert.equal(activeNavHref("/newer", HREFS), null);
});
