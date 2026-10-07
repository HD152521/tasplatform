/**
 * SR 심각도 표.
 *
 * id 는 포털 실측값이다. 틀리면 등록이 거절되거나 **엉뚱한 우선순위로 들어가고**,
 * 그건 포털에서 그 케이스를 열어 보기 전까지 모른다.
 *
 * 한때 작성 폼과 간단히 올리기가 이 표를 각자 베껴 두고 있었다. 이 파일이 정본이다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_SEVERITY,
  SEVERITIES,
  priorityIdOf,
} from "../lib/severity.ts";

test("네 단계와 실측 id 가 짝을 이룬다", () => {
  assert.deepEqual([...SEVERITIES], [
    "Critical - P1", "High - P2", "Medium - P3", "Low - P4",
  ]);
  assert.equal(priorityIdOf("Critical - P1"), 1);
  assert.equal(priorityIdOf("High - P2"), 2);
  assert.equal(priorityIdOf("Medium - P3"), 3);
  assert.equal(priorityIdOf("Low - P4"), 4);
});

test("기본값은 P3 이고 목록에 있다", () => {
  assert.equal(DEFAULT_SEVERITY, "Medium - P3");
  assert.ok(SEVERITIES.includes(DEFAULT_SEVERITY));
  assert.equal(priorityIdOf(DEFAULT_SEVERITY), 3);
});

/*
 * 모르는 이름은 **P3** 으로 둔다. 등록을 막는 것보다 보통 우선순위로 올리는 편이 낫다 —
 * 심각도를 못 읽었다고 SR 을 못 올리면 그게 더 급한 일이 된다.
 */
test("모르는 이름은 P3 으로 둔다", () => {
  for (const bad of ["", "P1", "긴급", "Critical", "critical - p1"]) {
    assert.equal(priorityIdOf(bad), 3, `${JSON.stringify(bad)} 는 P3 이어야`);
  }
});

/*
 * **두 화면이 이 표를 베껴 쓰지 않는지 확인한다.** 베껴 두면 한쪽만 고쳐지고, 같은
 * 심각도를 골랐는데 서로 다른 우선순위로 등록된다. 그 사고가 실제로 있어 여기로 모았다.
 */
test("작성 폼과 간단히 올리기가 표를 베껴 두지 않았다", () => {
  for (const path of ["app/new/DraftForm.tsx", "app/new/QuickModal.tsx"]) {
    const source = readFileSync(path, "utf8");
    assert.ok(source.includes('from "../../lib/severity.ts"'),
      `${path} 가 lib/severity.ts 를 쓰지 않는다`);
    assert.ok(!/const\s+SEVERITIES\s*=/.test(source),
      `${path} 에 SEVERITIES 사본이 있다`);
    assert.ok(!/const\s+PRIORITY_ID\s*=/.test(source),
      `${path} 에 PRIORITY_ID 사본이 있다`);
  }
});
