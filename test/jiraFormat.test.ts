import { test } from "node:test";
import assert from "node:assert/strict";
import { isHeadOffice, parseCenter, spanLabel } from "../lib/jiraFormat.ts";

// 실제 NHTAS 이슈 제목들이다.
test("제목 앞 대괄호를 전산센터로 뗀다", () => {
  assert.deepEqual(parseCenter("[개발]Internal 통신 지연 원인 분석"),
    { center: "개발", title: "Internal 통신 지연 원인 분석" });
  assert.deepEqual(parseCenter("[DR] GEN 야간 작업"),
    { center: "DR", title: "GEN 야간 작업" });
  assert.deepEqual(parseCenter("[본사] ldap 변경 작업 영향도 파악"),
    { center: "본사", title: "ldap 변경 작업 영향도 파악" });
});

test("전산센터가 여러 개인 것도 그대로 둔다", () => {
  assert.equal(parseCenter("[개발/운영/DR/AWS] 8월 정기점검").center, "개발/운영/DR/AWS");
});

test("대괄호가 없으면 제목을 통째로 남긴다", () => {
  assert.deepEqual(parseCenter("NEO PaaS 클러스터 자원 재분배"),
    { center: "", title: "NEO PaaS 클러스터 자원 재분배" });
});

test("제목 뒤 공백을 정리한다", () => {
  assert.equal(parseCenter("[본사]Internal 통신 지연 원인 분석 ").title,
    "Internal 통신 지연 원인 분석");
});

test("생성일과 종료일이 다르면 범위로 쓴다", () => {
  assert.equal(spanLabel("2026-08-03T09:00:00.000+0900", "2026-08-14T18:00:00.000+0900"),
    "08/03 – 08/14");
});

test("같은 날 끝났으면 한 날짜로 접는다", () => {
  assert.equal(spanLabel("2026-08-05T09:00:00.000+0900", "2026-08-05T18:00:00.000+0900"),
    "08/05");
});

// 안 끝난 작업을 끝난 것처럼 보이게 하면 안 된다.
test("아직 안 끝났으면 뒤를 비워 둔다", () => {
  assert.equal(spanLabel("2026-08-05T09:00:00.000+0900", null), "08/05 –");
  assert.equal(spanLabel("2026-08-05T09:00:00.000+0900", ""), "08/05 –");
});

// NHTAS-172 는 제목이 [본사] 인데 상위가 [검증]... 이라 상위만 보면 통과해 버린다.
test("전산센터가 본사면 본사 업무로 본다", () => {
  assert.equal(isHeadOffice("본사"), true);
  assert.equal(isHeadOffice(" 본사 "), true);
});

test("여러 전산센터 중 하나라도 본사면 제외한다", () => {
  assert.equal(isHeadOffice("개발/본사"), true);
  assert.equal(isHeadOffice("본사/운영"), true);
});

test("본사가 아니면 통과시킨다", () => {
  for (const center of ["개발", "운영", "DR", "검증", "개발/운영/DR/AWS", ""]) {
    assert.equal(isHeadOffice(center), false, center);
  }
});
