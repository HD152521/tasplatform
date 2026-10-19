import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DRAFT_SYSTEM_PROMPT,
  QUESTIONS_HEADING,
  TIDY_SYSTEM_PROMPT,
  UNKNOWN_MARK,
  buildDraftUser,
  parseComposed,
  readMode,
  stripUngroundedTag,
  systemPromptFor,
} from "../lib/srDraftPrompt.ts";

const NEWLINE = String.fromCharCode(10);
const lines = (...parts: string[]): string => parts.join(NEWLINE);

/* ------------------------------------------------------------------ *
 * 프롬프트
 * ------------------------------------------------------------------ */

// 틀은 우리가 실제로 올린 120건에서 뽑았다. 지배적 모양은
// 인사말 → 제목 없는 줄글 → Questions → 맺음말 이다(섹션 제목 사용 22%).
test("팀이 쓰는 모양을 지시한다", () => {
  assert.match(DRAFT_SYSTEM_PROMPT, /Hello Support Team,/);
  assert.match(DRAFT_SYSTEM_PROMPT, /Thanks,/);
  assert.ok(DRAFT_SYSTEM_PROMPT.includes(QUESTIONS_HEADING));
});

test("쓰지 않는 소제목을 못박는다", () => {
  // Background 는 120건 중 1건뿐이었다. 붙이지 말라고 이름을 대고 막는다.
  assert.match(DRAFT_SYSTEM_PROMPT, /Background, Symptom, Environment 같은 소제목은/);
});

test("지어내지 말라고 못박는다", () => {
  assert.match(DRAFT_SYSTEM_PROMPT, /지어내지 않습니다/);
  assert.ok(DRAFT_SYSTEM_PROMPT.includes(UNKNOWN_MARK));
});

test("아는 값을 사실로 넘겨 준다", () => {
  const user = buildDraftUser({
    content: "OTel 켜면 리소스가 얼마나 더 드는지 궁금합니다",
    productName: "VMware Tanzu Application Service",
    componentName: "TAS System Applications",
    release: "TPCF 10.4",
    severity: "Medium - P3",
  });
  assert.match(user, /Product: VMware Tanzu Application Service/);
  assert.match(user, /Prod Release: TPCF 10\.4/);
  assert.match(user, /OTel 켜면/);
});

test("빈 값은 사실 목록에 넣지 않는다", () => {
  const user = buildDraftUser({ content: "내용", productName: "", release: "  " });
  assert.ok(!user.includes("Product:"));
  assert.ok(!user.includes("Prod Release:"));
});

test("이미 적어 둔 제목은 그대로 두라고 알린다", () => {
  const withSubject = buildDraftUser({ content: "내용", subject: "[TPCF 10.4] Sizing" });
  assert.match(withSubject, /그대로 두세요/);
  const without = buildDraftUser({ content: "내용" });
  assert.match(without, /아직 없음/);
});

/* ------------------------------------------------------------------ *
 * 응답 파싱
 * ------------------------------------------------------------------ */

const ANSWER = lines(
  "[SUBJECT]",
  "[TPCF 10.4] Resource sizing for enabling OpenTelemetry",
  "",
  "[CONTENT]",
  "Hello Support Team,",
  "",
  "We are running TPCF 10.4 and are reviewing the Tanzu Hub integration.",
  "",
  "Questions",
  "1. What is the recommended CPU and memory overhead per VM?",
  "2. Do we need to scale out?",
  "",
  "Thanks,",
  "",
  "[MISSING]",
  "- Ops Manager 버전",
  "- 에러가 처음 난 시각",
);

test("세 덩어리를 뽑는다", () => {
  const got = parseComposed(ANSWER);
  assert.equal(got.subject, "[TPCF 10.4] Resource sizing for enabling OpenTelemetry");
  assert.match(got.content, /^Hello Support Team,/);
  assert.match(got.content, /Thanks,$/);
  assert.deepEqual(got.missing, ["Ops Manager 버전", "에러가 처음 난 시각"]);
});

test("본문에 다음 덩어리 표식이 섞여 들어가지 않는다", () => {
  const got = parseComposed(ANSWER);
  assert.ok(!got.content.includes("MISSING"), got.content);
  assert.ok(!got.content.includes("[SUBJECT]"));
});

test("코드펜스로 감싸 와도 읽는다", () => {
  const got = parseComposed(lines("```", ANSWER, "```"));
  assert.match(got.content, /^Hello Support Team,/);
});

test("빠진 정보가 없다고 적어 오면 빈 목록으로 본다", () => {
  const got = parseComposed(lines("[CONTENT]", "Hello.", "", "[MISSING]", "없음"));
  assert.deepEqual(got.missing, []);
});

// 애써 만든 글을 형식 때문에 버리는 것이 가장 나쁘다.
test("표식을 통째로 빠뜨리면 전체를 본문으로 본다", () => {
  const got = parseComposed(lines("Hello Support Team,", "", "Just prose.", "", "Thanks,"));
  assert.equal(got.subject, "");
  assert.match(got.content, /Just prose\./);
  assert.deepEqual(got.missing, []);
});

test("제목이 여러 줄로 와도 첫 줄만 쓴다", () => {
  const got = parseComposed(lines("[SUBJECT]", "첫 줄", "군더더기", "[CONTENT]", "본문"));
  assert.equal(got.subject, "첫 줄");
  assert.equal(got.content, "본문");
});

test("대괄호 없이 라벨만 와도 읽는다", () => {
  const got = parseComposed(lines("SUBJECT:", "제목", "CONTENT:", "본문", "MISSING:", "- 버전"));
  assert.equal(got.subject, "제목");
  assert.equal(got.content, "본문");
  assert.deepEqual(got.missing, ["버전"]);
});

/* ------------------------------------------------------------------ *
 * 번역 / 다듬기
 * ------------------------------------------------------------------ */

test("모르는 mode 는 번역으로 둔다", () => {
  // 한국어를 영어로 못 바꿔 보내는 쪽이 더 나쁘다.
  assert.equal(readMode("tidy"), "tidy");
  assert.equal(readMode("translate"), "translate");
  assert.equal(readMode(undefined), "translate");
  assert.equal(readMode("아무거나"), "translate");
});

test("다듬기는 언어를 바꾸지 말라고 못박는다", () => {
  assert.match(TIDY_SYSTEM_PROMPT, /언어를 바꾸지 않습니다/);
  assert.match(TIDY_SYSTEM_PROMPT, /한국어로 옮기지 않습니다/);
  assert.match(TIDY_SYSTEM_PROMPT, /내용을 바꾸지 않습니다/);
});

test("다듬기도 같은 틀과 같은 출력 형식을 쓴다", () => {
  assert.ok(TIDY_SYSTEM_PROMPT.includes("Hello Support Team,"));
  assert.ok(TIDY_SYSTEM_PROMPT.includes(QUESTIONS_HEADING));
  assert.ok(TIDY_SYSTEM_PROMPT.includes("[SUBJECT]"));
  assert.match(TIDY_SYSTEM_PROMPT, /Background, Symptom, Environment 같은 소제목은/);
});

test("mode 에 따라 다른 프롬프트를 고른다", () => {
  assert.equal(systemPromptFor("tidy"), TIDY_SYSTEM_PROMPT);
  assert.equal(systemPromptFor("translate"), DRAFT_SYSTEM_PROMPT);
});

test("다듬기일 때는 본문 라벨이 달라진다", () => {
  const tidy = buildDraftUser({ content: "Some English text", mode: "tidy" });
  assert.match(tidy, /언어를 바꾸지 말고 다듬기만/);
  const translate = buildDraftUser({ content: "한국어", mode: "translate" });
  assert.ok(!translate.includes("언어를 바꾸지 말고"));
});

/* ------------------------------------------------------------------ *
 * 제목 앞 대괄호
 *
 * 이 자리는 담당자가 "어떤 제품·컴포넌트가 문제인지" 보고 적는 곳이다. 모델이 채우게
 * 두면 지어낸다 — 실제로 본문에 TPCF 10.4 라고 적혀 있는데 [TAS 2.3.4] 가 붙어 나왔다.
 * 제품도 버전도 근거 없는 값이었고, 그대로 올라가면 케이스가 엉뚱한 팀으로 갈 수 있다.
 * ------------------------------------------------------------------ */

const FACTS = "TPCF 10.4 환경에서 Apps Manager 를 통해 Application 상태를 확인하는 중";

test("지어낸 제품·버전은 떼어낸다", () => {
  assert.equal(
    stripUngroundedTag("[TAS 2.3.4] App Metrics showing as 0", FACTS),
    "App Metrics showing as 0",
  );
});

test("버전 하나만 틀려도 떼어낸다", () => {
  // 10.5 는 본문에 없다. 한 글자 차이가 알려진 이슈 대조를 어긋나게 한다.
  assert.equal(
    stripUngroundedTag("[TPCF 10.5] App Metrics showing as 0", FACTS),
    "App Metrics showing as 0",
  );
});

test("본문에 있는 제품·버전은 남긴다", () => {
  const subject = "[TPCF 10.4] App Metrics showing as 0";
  assert.equal(stripUngroundedTag(subject, FACTS), subject);
});

test("본문에 있는 컴포넌트명도 남긴다", () => {
  const subject = "[Apps Manager] App Metrics showing as 0";
  assert.equal(stripUngroundedTag(subject, FACTS), subject);
});

test("대괄호가 없으면 그대로 둔다", () => {
  assert.equal(stripUngroundedTag("App Metrics showing as 0", FACTS), "App Metrics showing as 0");
});

test("근거가 케이스 속성에서 와도 남긴다", () => {
  // 담당자가 Prod Release 칸에 적었으면 그것도 근거다(본문에 없어도 된다).
  const subject = "[TPCF 10.4] Something";
  assert.equal(stripUngroundedTag(subject, "TPCF 10.4"), subject);
});

test("빈 대괄호는 근거가 없으므로 뗀다", () => {
  assert.equal(stripUngroundedTag("[ ] Something", FACTS), "Something");
});

test("대소문자는 따지지 않는다", () => {
  const subject = "[tpcf 10.4] Something";
  assert.equal(stripUngroundedTag(subject, FACTS), subject);
});

test("두 프롬프트 모두 대괄호를 지어내지 말라고 못박는다", () => {
  for (const prompt of [DRAFT_SYSTEM_PROMPT, TIDY_SYSTEM_PROMPT]) {
    assert.match(prompt, /대괄호를 아예 쓰지 않습니다/);
    assert.match(prompt, /추측해서 만들지/);
  }
});

/* ------------------------------------------------------------------ *
 * Jira 티켓용 한글 (JIRA_TITLE / JIRA_BODY)
 *
 * 코드가 원문 첫 줄을 자르던 때는 `[운영] 앱 두 개가 계속 crash 납니다 진행` 같은
 * 제목이 나왔다. 첫 줄이 문장이면 뒤에 "진행" 이 붙어 말이 되지 않는다. 그래서 같은
 * 호출에서 모델에게 받는다 — 추가 대기 없이.
 * ------------------------------------------------------------------ */

const ANSWER_WITH_JIRA = lines(
  "[SUBJECT]",
  "[TPCF 10.4.2] Apps keep crashing",
  "",
  "[CONTENT]",
  "Hello Support Team,",
  "",
  "Two apps keep crashing.",
  "",
  "Thanks,",
  "",
  "[MISSING]",
  "- 발생 시각",
  "",
  "[JIRA_TITLE]",
  "TPCF 10.4.2 앱 반복 crash 원인 분석",
  "",
  "[JIRA_BODY]",
  "질문",
  "- OOM 으로 보이는 반복 crash 의 원인과 조치 방법",
  "",
  "배경",
  "- TPCF 10.4.2 운영, Diego cell 재시작 후에도 재현",
);

test("Jira 제목·본문을 함께 뽑는다", () => {
  const got = parseComposed(ANSWER_WITH_JIRA);
  assert.equal(got.jiraTitle, "TPCF 10.4.2 앱 반복 crash 원인 분석");
  assert.match(got.jiraBody, /^질문/);
  assert.match(got.jiraBody, /배경/);
  // 앞 덩어리들이 망가지지 않아야 한다 — 표식 목록에 새 이름을 빼먹으면 섞인다.
  assert.equal(got.subject, "[TPCF 10.4.2] Apps keep crashing");
  assert.match(got.content, /Thanks,$/);
  assert.deepEqual(got.missing, ["발생 시각"]);
  assert.doesNotMatch(got.missing.join(" "), /JIRA/, "다음 머리글이 섞였다");
  assert.doesNotMatch(got.content, /JIRA/);
});

/*
 * 대괄호와 꼬리말은 **코드가** 붙인다. 모델이 같이 붙여 오면 두 번 붙으므로 걷어낸다
 * — 실측으로 모델은 이런 지시를 꽤 자주 어긴다.
 */
test("모델이 붙여 온 대괄호와 '진행' 은 걷어낸다", () => {
  for (const given of [
    "[운영] 앱 반복 crash 원인 분석 진행",
    "[개발] 앱 반복 crash 원인 분석",
    "앱 반복 crash 원인 분석 진행",
    "[AWS] 앱 반복 crash 원인 분석 진행",
  ]) {
    const got = parseComposed(lines("[CONTENT]", "x", "", "[JIRA_TITLE]", given));
    assert.equal(got.jiraTitle, "앱 반복 crash 원인 분석", `입력: ${given}`);
  }
});

// 모델이 두 덩어리를 빠뜨려도 나머지는 멀쩡해야 한다. 그때는 부르는 쪽이 원문에서 뽑는다.
test("Jira 덩어리가 없으면 빈 문자열이다", () => {
  const got = parseComposed(ANSWER);
  assert.equal(got.jiraTitle, "");
  assert.equal(got.jiraBody, "");
  assert.equal(got.subject, "[TPCF 10.4] Resource sizing for enabling OpenTelemetry");
});

// 표식이 하나도 없는 응답도 지금처럼 전부 본문으로 본다.
test("표식이 없으면 Jira 값도 비어 있다", () => {
  const got = parseComposed("Hello Support Team,\n\nJust prose.\n\nThanks,");
  assert.equal(got.jiraTitle, "");
  assert.equal(got.jiraBody, "");
  assert.match(got.content, /Just prose/);
});
