/**
 * 스모크 스크립트의 응답 판정(checkResult) 테스트.
 *
 * 밀폐(hermetic): 실제 네트워크·DB 없이 순수 판정만 검증한다. scripts/smoke.mjs 는 진입점
 * 가드가 있어 import 만으로 main(네트워크/exit)이 돌지 않는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkResult } from "../scripts/smoke.mjs";

test("200 + JSON ok:true → pass", () => {
  const r = checkResult("/api/health", 200, true);
  assert.equal(r.ok, true);
  assert.equal(r.path, "/api/health");
});

test("200 (JSON 판정 없는 서버렌더 경로) → pass", () => {
  assert.equal(checkResult("/", 200).ok, true);
});

test("500 → fail", () => {
  const r = checkResult("/api/health", 500, false);
  assert.equal(r.ok, false);
  assert.match(r.detail, /500/);
});

test("비200(예: 302 리다이렉트) → fail", () => {
  assert.equal(checkResult("/settings", 302).ok, false);
});

test("200 이지만 JSON ok:false → fail", () => {
  const r = checkResult("/api/settings?team=default", 200, false);
  assert.equal(r.ok, false);
  assert.equal(r.detail, "json ok:false");
});

test("네트워크 오류/타임아웃(status 0) → fail", () => {
  const r = checkResult("/api/health", 0);
  assert.equal(r.ok, false);
  assert.equal(r.detail, "network_error");
});
