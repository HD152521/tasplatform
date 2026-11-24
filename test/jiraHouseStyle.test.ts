/**
 * 이 팀이 Jira 에 실제로 쓰는 양식.
 *
 * 표본은 NHTAS 370건 집계에서 그대로 가져왔다(lib/jiraHouseStyle.ts 머리말).
 * 여기가 틀리면 보고서 집계(lib/jira.ts)가 그 건을 놓치거나 다른 법인으로 센다 —
 * **조용히 틀리는** 종류라 시험으로 잠근다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WORK_LABELS,
  classifyTags,
  corpEpicKey,
  describeClassification,
  houseHeadLine,
  houseSummary,
  houseWhenLine,
  readCorpTag,
  readScope,
  readWorkLabel,
  sortScopes,
} from "../lib/jiraHouseStyle.ts";

/* ------------------------------------------------------------------ *
 * 망 읽기
 * ------------------------------------------------------------------ */

test("망 이름과 줄임말을 읽는다", () => {
  assert.equal(readScope("운영"), "운영");
  assert.equal(readScope("운"), "운영");
  assert.equal(readScope("개발"), "개발");
  assert.equal(readScope("개"), "개발");
  assert.equal(readScope("DR"), "DR");
  assert.equal(readScope("AWS"), "AWS");
  assert.equal(readScope("검증"), "검증");
  assert.equal(readScope("안성"), "안성");
});

test("망은 대소문자를 접는다", () => {
  // aws·AWS·Aws 가 모두 같은 것이다. 안 접으면 [aws] 와 [AWS] 로 갈려 눈으로 안 묶인다.
  for (const tag of ["aws", "AWS", "Aws", "aWs"]) {
    assert.equal(readScope(tag), "AWS", tag);
  }
  for (const tag of ["dr", "DR", "Dr"]) {
    assert.equal(readScope(tag), "DR", tag);
  }
});

test("모르는 태그는 망이 아니다", () => {
  assert.equal(readScope("점검"), null);
  assert.equal(readScope("장애"), null);
  assert.equal(readScope(""), null);
});

/* ------------------------------------------------------------------ *
 * 법인 읽기 — 은=은행, 중=중앙회
 * ------------------------------------------------------------------ */

test("법인 줄임말을 읽는다", () => {
  assert.equal(readCorpTag("은"), "은행");
  assert.equal(readCorpTag("은행"), "은행");
  assert.equal(readCorpTag("중"), "중앙회");
  assert.equal(readCorpTag("중앙회"), "중앙회");
  assert.equal(readCorpTag("본"), "본사");
  assert.equal(readCorpTag("본사"), "본사");
});

test("중앙회가 은행으로 읽히지 않는다", () => {
  // lib/jira.ts 의 readCorp 는 에픽 이름 안에서 찾기 때문에 순서가 중요하지만,
  // 여기는 완전일치 표라 그 함정이 없다. 그래도 잠가 둔다.
  assert.equal(readCorpTag("중앙회"), "중앙회");
  assert.equal(readCorpTag("NH중앙회"), "중앙회");
});

/* ------------------------------------------------------------------ *
 * 태그 가르기
 * ------------------------------------------------------------------ */

test("태그를 망·법인·나머지로 가른다", () => {
  const c = classifyTags(["개발", "운영", "은", "점검"]);
  assert.deepEqual(c.scopes, ["개발", "운영"]);
  assert.equal(c.corp, "은행");
  assert.deepEqual(c.rest, ["점검"]);
});

test("망 순서를 고정한다", () => {
  // 같은 조합이 [개발/운영/DR] 과 [운영/개발/DR] 로 갈려 있었다. 흔한 쪽으로 모은다.
  assert.deepEqual(classifyTags(["DR", "운영", "개발"]).scopes, ["개발", "운영", "DR"]);
  assert.deepEqual(sortScopes(["AWS", "DR", "운영", "개발"]), ["개발", "운영", "DR", "AWS"]);
});

test("같은 망을 두 번 적어도 한 번만 들어간다", () => {
  assert.deepEqual(classifyTags(["운영", "운", "운영"]).scopes, ["운영"]);
});

test("본사는 망이면서 법인이다 — 둘 다로 기록한다", () => {
  // 실제로 [본사] 가 91건이고 에픽도 NH본사 지원이다.
  const c = classifyTags(["본사"]);
  assert.deepEqual(c.scopes, ["본사"]);
  assert.equal(c.corp, "본사");
  assert.deepEqual(c.rest, []);
});

test("법인은 처음 적은 것을 쓴다", () => {
  // 두 법인을 함께 적는 양식은 없다.
  assert.equal(classifyTags(["은", "중"]).corp, "은행");
});

test("태그가 없으면 전부 빈다", () => {
  const c = classifyTags([]);
  assert.deepEqual(c.scopes, []);
  assert.equal(c.corp, null);
  assert.deepEqual(c.rest, []);
});

/* ------------------------------------------------------------------ *
 * 제목 — 실제 표본과 같은 모양이어야 한다
 * ------------------------------------------------------------------ */

test("망 하나면 [망] 제목", () => {
  assert.equal(
    houseSummary({ scopes: ["운영"], title: "클러스터 이관 본작업(철야)" }),
    "[운영] 클러스터 이관 본작업(철야)",
  );
});

test("망 여럿이면 / 로 잇는다", () => {
  assert.equal(
    houseSummary({ scopes: ["개발", "운영", "DR", "AWS"], title: "10월 정기 점검" }),
    "[개발/운영/DR/AWS] 10월 정기 점검",
  );
  assert.equal(
    houseSummary({ scopes: ["DR", "운영"], title: "GEN 작업" }),
    "[운영/DR] GEN 작업",
    "적은 순서가 아니라 정해진 순서로 적는다",
  );
});

test("망이 없고 법인이 본사면 [본사] 를 쓴다", () => {
  // 기존 91건이 그 모양이다.
  assert.equal(
    houseSummary({ scopes: [], corp: "본사", title: "PaaS 보안 관련 문서 작성" }),
    "[본사] PaaS 보안 관련 문서 작성",
  );
});

test("은행·중앙회는 제목에 넣지 않는다 — 에픽이 말해 준다", () => {
  assert.equal(houseSummary({ scopes: [], corp: "은행", title: "모니터링 지원" }), "모니터링 지원");
  assert.equal(houseSummary({ scopes: [], corp: "중앙회", title: "모니터링 지원" }), "모니터링 지원");
});

test("아무 것도 없으면 대괄호가 없다", () => {
  // 대괄호 없는 건도 실제로 13건 있다. 억지로 붙이지 않는다.
  assert.equal(houseSummary({ scopes: [], corp: null, title: "ASG 적용 테스트" }), "ASG 적용 테스트");
});

test("제목 앞뒤 공백은 떼고, 망이 있으면 한 칸만 띈다", () => {
  assert.equal(houseSummary({ scopes: ["운영"], title: "  GEN 작업  " }), "[운영] GEN 작업");
});

/* ------------------------------------------------------------------ *
 * 라벨
 * ------------------------------------------------------------------ */

test("기본 라벨은 작업지원이다", () => {
  // 248건이 그것이다. 모르는 태그를 장애대응으로 잘못 붙이면 장애 집계가 부푼다.
  assert.equal(readWorkLabel([]), WORK_LABELS.support);
  assert.equal(readWorkLabel(["점검"]), WORK_LABELS.support);
  assert.equal(readWorkLabel(["업그레이드"]), WORK_LABELS.support);
});

test("장애·내부 태그는 그 라벨로 간다", () => {
  assert.equal(readWorkLabel(["장애"]), WORK_LABELS.incident);
  assert.equal(readWorkLabel(["내부"]), WORK_LABELS.internal);
  assert.equal(readWorkLabel(["회의"]), WORK_LABELS.internal);
  assert.equal(readWorkLabel(["교육"]), WORK_LABELS.internal);
});

test("라벨 이름이 실제 쓰이는 값과 같다", () => {
  assert.equal(WORK_LABELS.support, "TAS_작업지원");
  assert.equal(WORK_LABELS.incident, "TAS_장애대응");
  assert.equal(WORK_LABELS.internal, "TAS_내부업무");
});

/* ------------------------------------------------------------------ *
 * 에픽
 * ------------------------------------------------------------------ */

test("법인별 에픽을 설정에서 읽는다", () => {
  process.env.JIRA_SR_EPIC = "FALL-1";
  process.env.JIRA_EPIC_BANK = "BANK-1";
  process.env.JIRA_EPIC_CENTRAL = "CENT-1";
  process.env.JIRA_EPIC_HQ = "HQ-1";

  assert.deepEqual(corpEpicKey("은행"), { key: "BANK-1", exact: true });
  assert.deepEqual(corpEpicKey("중앙회"), { key: "CENT-1", exact: true });
  assert.deepEqual(corpEpicKey("본사"), { key: "HQ-1", exact: true });
  assert.deepEqual(corpEpicKey(null), { key: "FALL-1", exact: false });
});

test("법인 에픽이 설정에 없으면 기존 에픽으로 떨어지고 그 사실을 알린다", () => {
  // 전부 한 에픽에 달리지만, 이슈가 아예 안 만들어지는 것보다 낫다.
  process.env.JIRA_SR_EPIC = "FALL-1";
  delete process.env.JIRA_EPIC_CENTRAL;
  const got = corpEpicKey("중앙회");
  assert.equal(got.key, "FALL-1");
  assert.equal(got.exact, false, "정확히 맞춘 게 아니라는 것을 부르는 쪽이 알아야 한다");
});

/* ------------------------------------------------------------------ *
 * 사람이 읽을 요약
 * ------------------------------------------------------------------ */

test("분류를 한 줄로 말한다", () => {
  assert.equal(
    describeClassification(classifyTags(["개발", "운영", "은", "점검"])),
    "망 개발/운영 · 법인 은행 · 작업지원",
  );
  assert.equal(describeClassification(classifyTags(["장애"])), "장애대응");
});

/* ------------------------------------------------------------------ *
 * 본문 양식 — 실측 80건(2026-11-24)
 *
 * 80건 전부 본문이 있고, 첫 줄은 법인·망을 글로 앞세운 "무엇을" 이다.
 * 메타데이터를 라벨로 나열한 건은 하나도 없었다.
 * ------------------------------------------------------------------ */

test("본문 첫 줄은 법인 · 망 · 무엇 순이다", () => {
  // 실측: `은행 운영 GSLB전환 모니터링`
  assert.equal(
    houseHeadLine({ scopes: ["운영"], corp: "은행", title: "GSLB전환 모니터링" }),
    "은행 운영 GSLB전환 모니터링",
  );
});

test("망이 여럿이면 제목과 같은 순서로 잇는다", () => {
  assert.equal(
    houseHeadLine({ scopes: ["운영", "개발"], corp: "중앙회", title: "bbr 백업 테스트" }),
    "중앙회 개발/운영 bbr 백업 테스트",
  );
});

test("본사는 두 번 적지 않는다 — 망이면서 법인이다", () => {
  assert.equal(
    houseHeadLine({ scopes: ["본사"], corp: "본사", title: "문서 작성" }),
    "본사 문서 작성",
  );
});

test("법인·망을 모르면 제목만 남는다", () => {
  assert.equal(houseHeadLine({ scopes: [], corp: null, title: "ASG 테스트" }), "ASG 테스트");
});

test("종일이면 시각을 적지 않는다", () => {
  assert.equal(
    houseWhenLine({ startDate: "2026-12-10", endDate: "2026-12-10", startTime: "", endTime: "" }),
    "일시: 2026-12-10 (종일)",
  );
});

test("시각이 있으면 짧은 줄로 적는다", () => {
  // 실측: `09:00~04:00`(철야) · `08:00~`(끝 시각 없음)
  assert.equal(
    houseWhenLine({ startDate: "2026-12-10", endDate: "", startTime: "09:00", endTime: "04:00" }),
    "일시: 2026-12-10 09:00~04:00",
  );
  assert.equal(
    houseWhenLine({ startDate: "2026-12-10", endDate: "2026-12-10", startTime: "08:00", endTime: "" }),
    "일시: 2026-12-10 08:00~",
  );
});

test("여러 날이면 기간으로 적는다", () => {
  assert.equal(
    houseWhenLine({ startDate: "2026-12-12", endDate: "2026-12-13", startTime: "", endTime: "" }),
    "일시: 2026-12-12 ~ 2026-12-13 (종일)",
  );
});

test("날짜가 없으면 줄을 만들지 않는다", () => {
  // 빈 줄이 본문에 남으면 "일시: (종일)" 같은 말이 된다.
  assert.equal(houseWhenLine({ startDate: "", endDate: "", startTime: "", endTime: "" }), "");
});
