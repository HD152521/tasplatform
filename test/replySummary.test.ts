import { test } from "node:test";
import assert from "node:assert/strict";
import { EXCERPT_LIMIT, excerpt, stripBoilerplate, summarizeReplies } from "../lib/replySummary.ts";

const NEWLINE = String.fromCharCode(10);
const lines = (...parts: string[]): string => parts.join(NEWLINE);

/**
 * 답변의 "모양"만 본뜬 합성 데이터다.
 *
 * 실제 케이스 번호·담당자명·고객 문장을 넣지 않는다. 이 저장소는 공개이고,
 * 케이스 번호와 담당자명이 붙으면 어느 고객사의 어떤 장애였는지 특정할 단서가 된다.
 */
const FAKE_CASE = "99990001";

// 답변은 예외 없이 인사말로 시작하고 서명으로 끝난다. 그 사이만 내용이다.
const NUDGE = lines(
  "Hi team,",
  "",
  "Hope this message finds you well.",
  "",
  "Have you had a chance to check the response?",
  "",
  "Please feel free to let us know if you have any questions or concerns.",
  "",
  "Best,",
  "",
  "Sample Engineer",
);

test("인사말·상투어·서명을 걷어내고 요점만 남긴다", () => {
  assert.equal(stripBoilerplate(NUDGE), "Have you had a chance to check the response?");
});

// 인사말을 남겨 두면 발췌 200자의 절반이 "Hope this message finds you well" 로 날아간다.
test("발췌는 인사말 대신 요점부터 시작한다", () => {
  const text = excerpt(NUDGE);
  assert.ok(text.startsWith("Have you had a chance"), text);
});

/**
 * 상투어 판정이 과하면 요약의 존재 이유가 사라진다.
 * "Please let us know ..." 로 시작하지만 실은 고객이 판단해야 할 일을 묻는 줄들.
 */
test("상투어처럼 시작해도 실질 요청이 붙으면 남긴다", () => {
  const actionable = [
    "Please let us know if you would like us to close this case, otherwise it will remain open for 5 business days.",
    "Please let us know the maintenance window so we can schedule the patch.",
    "Feel free to reach out once the configuration change has been applied to the staging foundation.",
    "We look forward to the output of the diagnostic script on the affected instance group.",
  ];
  for (const line of actionable) {
    const kept = stripBoilerplate(lines("Hi Team,", "", line, "", "Best regards,", "Sample Engineer"));
    assert.equal(kept, line, `지워지면 안 되는 줄: ${line}`);
  }
});

test("순수 마무리 상투어는 버린다", () => {
  const noise = [
    "Please feel free to let us know if you have any questions or concerns.",
    "Please let us know if you have any further questions.",
    "Please do not hesitate to contact us if you need any assistance.",
    "Let us know if you have any concerns.",
    "We look forward to hearing back from you.",
    "We await your confirmation.",
  ];
  for (const line of noise) {
    const kept = stripBoilerplate(lines("Hi Team,", "", "The patch is available.", "", line, "", "Regards,", "Sample Engineer"));
    assert.equal(kept, "The patch is available.", `남으면 안 되는 줄: ${line}`);
  }
});

test("본문 중간의 Thanks 로 뒷부분을 버리지 않는다", () => {
  const mid = lines(
    "Hi Team,",
    "",
    "Thanks,",
    "",
    "We checked the logs and found uneven disk usage across the instance group.",
    "",
    "Could you please run the command and share the output?",
    "",
    "Best regards,",
    "Sample Engineer",
  );
  const kept = stripBoilerplate(mid);
  assert.ok(kept.includes("uneven disk usage"), kept);
  assert.ok(kept.includes("share the output"), kept);
  assert.ok(!kept.includes("Sample Engineer"), kept);
});

test("본문이 전부 상투어면 빈 문자열이 된다", () => {
  assert.equal(stripBoilerplate(lines("Hello,", "", "Thank you for your patience.", "", "Regards,", "Sample Engineer")), "");
});

test("발췌는 길이를 넘기지 않고 단어 경계에서 끊는다", () => {
  const long = "The default memory limit for the cache component was changed because the previous value was unsuitable for both small and large deployments, and the new value applies to every instance group created after the upgrade completes.";
  const text = excerpt(long);
  assert.ok(text.length <= EXCERPT_LIMIT + 1, `길이 ${text.length}`);
  assert.ok(!text.includes("  "), text);
});

test("짧은 본문은 그대로 둔다", () => {
  assert.equal(excerpt(lines("Hi Team,", "", "Fix is available in 6.0.4.")), "Fix is available in 6.0.4.");
});

// 키가 없어도 알림은 나가야 한다. 요약만 발췌로 떨어진다.
test("OPENAI_API_KEY 가 없으면 전부 발췌로 대신하고 사유를 알린다", async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const warnings: string[] = [];
  try {
    const out = await summarizeReplies(
      [{ caseLabel: FAKE_CASE, subject: "Sample upgrade inquiry", author: "Broadcom Internal", body: NUDGE }],
      (message) => warnings.push(message),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]?.source, "excerpt");
    assert.equal(out[0]?.text, "Have you had a chance to check the response?");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /OPENAI_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  }
});

test("요약할 것이 없으면 빈 배열이고 경고도 없다", async () => {
  const warnings: string[] = [];
  const out = await summarizeReplies([], (message) => warnings.push(message));
  assert.deepEqual(out, []);
  assert.deepEqual(warnings, []);
});
