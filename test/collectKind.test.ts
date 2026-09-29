/**
 * "무엇을 수집하는가" 가 끝까지 섞이지 않는지.
 *
 * 화면 → API → 수집기 사이에서 종류가 한 번만 흐트러져도 "보안 공지를 눌렀는데 케이스
 * 수집이 도는" 일이 생긴다. 그러면 사람은 완료를 보고, 목록은 그대로고, 어디에도 이유가
 * 남지 않는다. 그래서 종류 이름을 읽는 곳과 자식 프로세스를 고르는 곳을 여기서 잠근다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { COLLECT_KINDS, parseCollectKind } from "../lib/collectKind.ts";
import { childPlanFor } from "../collector/worker.ts";

test("종류를 말하지 않으면 케이스다 (이미 배포된 화면이 그렇게 부른다)", () => {
  assert.equal(parseCollectKind(null), "cases");
  assert.equal(parseCollectKind(undefined), "cases");
  assert.equal(parseCollectKind(""), "cases");
  assert.equal(parseCollectKind("   "), "cases");
});

test("아는 종류는 그대로 읽는다", () => {
  for (const kind of COLLECT_KINDS) {
    assert.equal(parseCollectKind(kind), kind);
  }
});

// 조용히 케이스로 떨어뜨리면 오타 하나가 엉뚱한 수집을 돌린다. 부르는 쪽이 거절해야 한다.
test("모르는 종류는 null 이다 (케이스로 떨어지지 않는다)", () => {
  assert.equal(parseCollectKind("case"), null);
  assert.equal(parseCollectKind("CVES"), null);
  assert.equal(parseCollectKind("attachments"), null);
});

test("종류마다 제 수집기가 돈다", () => {
  const cases = childPlanFor("cases", 1234);
  assert.match(cases.entry, /collect\.ts$/);
  assert.equal(cases.timeoutMs, 1234, "케이스 상한은 환경변수 설정을 따른다");

  const cves = childPlanFor("cves", 1234);
  assert.match(cves.entry, /collect-cves\.ts$/);

  const kb = childPlanFor("kb", 1234);
  assert.match(kb.entry, /collect-kb\.ts$/);
});

// collect-cves.ts / collect-kb.ts 의 이름에 "collect" 가 들어 있어, 정규식 없이 비교하면
// 케이스 수집기와 헷갈리기 쉽다. 세 진입점이 서로 다른 파일임을 못 박는다.
test("세 수집기의 진입점이 서로 다르다", () => {
  const entries = COLLECT_KINDS.map((kind) => childPlanFor(kind, 1000).entry);
  assert.equal(new Set(entries).size, COLLECT_KINDS.length, entries.join(" / "));
});

test("종류마다 회차 상한이 있다(0 이면 자식이 바로 죽는다)", () => {
  for (const kind of COLLECT_KINDS) {
    assert.ok(childPlanFor(kind, 300_000).timeoutMs > 0, kind);
  }
});
