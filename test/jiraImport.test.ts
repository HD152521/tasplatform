/**
 * Jira → 캘린더 가져오기.
 *
 * 매핑이 조용히 틀리는 종류라 순수 함수로 떼어 잠근다. 표본은 실제 제목에서 가져왔다
 * (`[운영] 클러스터 이관 본작업(철야)`, `[개발/운영/DR/AWS] 10월 정기 점검` 등).
 *
 * 특히 조심한 것:
 *   - 모르는 상태를 **완료로 보지 않는다.** 안 한 일이 한 일로 집계된다.
 *   - 날짜가 뒤집힌 이슈(해결일 < 시작일)가 실제로 있다. 저장 계층이 거절하므로
 *     시작일로 접는다 — 그 건만 조용히 빠지면 안 된다.
 *   - SR·에픽·캘린더가 만든 이슈는 가져오지 않는다. SR 은 다른 화면이 이미 다룬다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { importFrom, mapIssue, skipReason, stateFromStatus } from "../lib/jiraImport.ts";

/** 이슈 하나를 만든다. 필드 이름은 Jira 응답 그대로. */
function issue(fields: Record<string, unknown>, key = "NHTAS-1"): Parameters<typeof mapIssue>[0] {
  return {
    key,
    fields: {
      summary: "제목",
      status: { name: "완료" },
      created: "2026-11-05T10:00:00.000+0900",
      ...fields,
    },
  } as Parameters<typeof mapIssue>[0];
}

/* ------------------------------------------------------------------ *
 * 상태
 * ------------------------------------------------------------------ */

test("Jira 상태를 일정 상태로 옮긴다", () => {
  // 실측 분포: 완료 309 · 해결됨 29 · 해야 할 일 19 · 진행 중 13
  assert.equal(stateFromStatus("완료"), "done");
  assert.equal(stateFromStatus("해결됨"), "done");
  assert.equal(stateFromStatus("진행 중"), "doing");
  assert.equal(stateFromStatus("해야 할 일"), "planned");
  assert.equal(stateFromStatus("Done"), "done");
  assert.equal(stateFromStatus("In Progress"), "doing");
});

test("모르는 상태는 예정이다 — 완료로 보면 안 한 일이 한 일이 된다", () => {
  assert.equal(stateFromStatus("검토 대기"), "planned");
  assert.equal(stateFromStatus(""), "planned");
  assert.equal(stateFromStatus("보류"), "planned");
});

/* ------------------------------------------------------------------ *
 * 제목 → 망 · 제목
 * ------------------------------------------------------------------ */

test("제목 앞 대괄호가 전산망이 된다", () => {
  const got = mapIssue(issue({ summary: "[운영] 클러스터 이관 본작업(철야)" }));
  assert.equal(got?.scopes, "운영");
  assert.equal(got?.title, "클러스터 이관 본작업(철야)");
});

test("망 여럿은 정해진 순서로 모인다", () => {
  const got = mapIssue(issue({ summary: "[개발/운영/DR/AWS] 10월 정기 점검" }));
  assert.equal(got?.scopes, "개발/운영/DR/AWS");
  assert.equal(got?.title, "10월 정기 점검");

  // 거꾸로 적힌 것도 같은 값으로 모인다 — 눈으로 묶이게.
  const flipped = mapIssue(issue({ summary: "[운영/개발/DR] 9월 정기점검" }));
  assert.equal(flipped?.scopes, "개발/운영/DR");
});

test("대괄호가 없으면 망이 비고 제목이 그대로다", () => {
  const got = mapIssue(issue({ summary: "ASG 적용 테스트" }));
  assert.equal(got?.scopes, "");
  assert.equal(got?.title, "ASG 적용 테스트");
});

test("대괄호에 날짜 같은 것이 들어 있어도 버리지 않는다", () => {
  // 실제로 `[260910] 회의록` 이 있다. 망으로 읽히지 않지만 제목은 남아야 한다.
  const got = mapIssue(issue({ summary: "[260910] 회의록" }));
  assert.equal(got?.scopes, "");
  assert.equal(got?.title, "회의록");
});

test("제목이 비면 가져오지 않는다", () => {
  assert.equal(mapIssue(issue({ summary: "   " })), null);
});

/* ------------------------------------------------------------------ *
 * 법인
 * ------------------------------------------------------------------ */

test("상위 에픽 이름에서 법인을 읽는다", () => {
  const bank = mapIssue(issue({
    summary: "[운영] 모니터링 지원",
    parent: { key: "NHTAS-25", fields: { summary: "NH은행 운영지원" } },
  }));
  assert.equal(bank?.corp, "은행");

  const central = mapIssue(issue({
    summary: "[운영] 모니터링 지원",
    parent: { key: "NHTAS-26", fields: { summary: "NH중앙회 운영지원" } },
  }));
  assert.equal(central?.corp, "중앙회");
});

test("제목이 본사라고 말하면 본사다", () => {
  // 제목이 [본사] 인데 상위가 다른 쪽인 경우가 실제로 있다
  // (lib/jiraFormat.ts isHeadOffice 의 근거와 같다).
  const got = mapIssue(issue({
    summary: "[본사] BOSH Tile 속성 테스트",
    parent: { key: "NHTAS-171", fields: { summary: "[검증]BOSH-Agent 재기동 여부 테스트" } },
  }));
  assert.equal(got?.corp, "본사");
  assert.equal(got?.scopes, "본사");
});

test("상위가 없으면 법인이 빈다", () => {
  assert.equal(mapIssue(issue({ summary: "[운영] 작업" }))?.corp, "");
});

/* ------------------------------------------------------------------ *
 * 날짜
 * ------------------------------------------------------------------ */

test("Start date 를 시작일로 쓴다", () => {
  const got = mapIssue(issue({
    customfield_10015: "2026-11-20",
    created: "2026-11-05T10:00:00.000+0900",
  }));
  assert.equal(got?.startDate, "2026-11-20");
});

test("Start date 가 없으면 생성일을 쓴다", () => {
  const got = mapIssue(issue({ created: "2026-11-05T23:50:00.000+0900" }));
  assert.equal(got?.startDate, "2026-11-05", "+0900 이 붙어 오므로 글자만 자른다");
});

test("종료일은 duedate → 해결일 → 시작일 순이다", () => {
  assert.equal(
    mapIssue(issue({ customfield_10015: "2026-11-10", duedate: "2026-11-12" }))?.endDate,
    "2026-11-12",
  );
  assert.equal(
    mapIssue(issue({
      customfield_10015: "2026-11-10",
      duedate: null,
      resolutiondate: "2026-11-11T18:00:00.000+0900",
    }))?.endDate,
    "2026-11-11",
  );
  assert.equal(mapIssue(issue({ customfield_10015: "2026-11-10" }))?.endDate, "2026-11-10");
});

test("날짜가 뒤집혀 있으면 시작일로 접는다", () => {
  // 저장 계층이 "종료일이 시작일보다 앞" 을 거절한다. 접지 않으면 그 건이 조용히 빠진다.
  const got = mapIssue(issue({
    customfield_10015: "2026-11-20",
    resolutiondate: "2026-11-10T10:00:00.000+0900",
  }));
  assert.equal(got?.startDate, "2026-11-20");
  assert.equal(got?.endDate, "2026-11-20");
});

test("날짜를 전혀 알 수 없으면 가져오지 않는다", () => {
  assert.equal(mapIssue(issue({ created: undefined })), null);
});

/* ------------------------------------------------------------------ *
 * 담당자 · 라벨
 * ------------------------------------------------------------------ */

test("담당자의 accountId 와 이름을 들고 온다", () => {
  const got = mapIssue(issue({
    assignee: { accountId: "acct-9", displayName: "안용식" },
  }));
  assert.equal(got?.assigneeAccountId, "acct-9");
  assert.equal(got?.assigneeLabel, "안용식");
});

test("담당자가 없어도 가져온다", () => {
  const got = mapIssue(issue({ assignee: null }));
  assert.equal(got?.assigneeAccountId, "");
  assert.equal(got?.assigneeLabel, "");
});

test("라벨에서 업무 성격을 읽는다", () => {
  assert.equal(mapIssue(issue({ labels: ["TAS_장애대응"] }))?.kind, "장애");
  assert.equal(mapIssue(issue({ labels: ["TAS_내부업무"] }))?.kind, "내부");
  assert.equal(mapIssue(issue({ labels: ["TAS_작업지원"] }))?.kind, "", "기본은 비워 둔다");
});

/* ------------------------------------------------------------------ *
 * 건너뛰기
 * ------------------------------------------------------------------ */

test("에픽·SR·캘린더가 만든 것은 건너뛴다", () => {
  assert.equal(skipReason(issue({ issuetype: { name: "에픽" } })), "에픽");
  assert.equal(skipReason(issue({ issuetype: { name: "Epic" } })), "에픽");
  assert.equal(skipReason(issue({ issuetype: { name: "SR오픈" } })), "SR");
  assert.equal(skipReason(issue({ labels: ["TAS_SR"] })), "SR", "SR 은 다른 화면이 다룬다");
  assert.equal(skipReason(issue({ labels: ["SRHUB_CAL"] })), "캘린더가 만든 것");
});

test("보통 작업은 건너뛰지 않는다", () => {
  assert.equal(skipReason(issue({ issuetype: { name: "작업" }, labels: ["TAS_작업지원"] })), null);
  assert.equal(skipReason(issue({ issuetype: { name: "하위 작업" } })), null);
});

/* ------------------------------------------------------------------ *
 * 시작점
 * ------------------------------------------------------------------ */

test("시작점 기본값은 이번 달 1일이다", () => {
  delete process.env.JIRA_IMPORT_FROM;
  assert.match(importFrom(), /^\d{4}-\d{2}-01$/);
});

test("시작점을 설정으로 바꿀 수 있다", () => {
  process.env.JIRA_IMPORT_FROM = "2026-11-01";
  assert.equal(importFrom(), "2026-11-01");
});

test("형식이 틀린 설정은 무시하고 기본값으로 떨어진다", () => {
  // 조용히 엉뚱한 날짜로 긁어 오면 과거가 달력을 가득 채운다.
  process.env.JIRA_IMPORT_FROM = "11/01";
  assert.match(importFrom(), /^\d{4}-\d{2}-01$/);
  delete process.env.JIRA_IMPORT_FROM;
});
