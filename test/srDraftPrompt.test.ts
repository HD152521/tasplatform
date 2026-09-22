import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DRAFT_SYSTEM_PROMPT,
  QUESTIONS_HEADING,
  UNKNOWN_MARK,
  buildDraftUser,
  parseComposed,
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
