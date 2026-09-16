/**
 * 프롬프트 환경변수 오버라이드.
 *
 * env 가 설정되면 그 값으로, 없으면 기존 기본값으로 동작해야 한다. env 를 건드리므로
 * 각 테스트 뒤 원래 값으로 복원해 다른 테스트를 오염시키지 않는다(밀폐).
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promptOverride } from "../lib/prompts.ts";
import { confluenceSystemPrompt } from "../lib/summaryPrompt.ts";

const KEYS = ["SR_PROMPT_CONFLUENCE", "SR_PROMPT_REPLY_SUMMARY", "SR_PROMPT_SR_REPORT", "SR_TEST_KEY"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of KEYS) {
    const original = saved[k];
    if (original === undefined) delete process.env[k];
    else process.env[k] = original;
  }
});

test("promptOverride: env 가 없으면 fallback 을 준다", () => {
  delete process.env.SR_TEST_KEY;
  assert.equal(promptOverride("SR_TEST_KEY", "기본값"), "기본값");
});

test("promptOverride: env 가 있으면 그 값을 준다", () => {
  process.env.SR_TEST_KEY = "덮어쓴값";
  assert.equal(promptOverride("SR_TEST_KEY", "기본값"), "덮어쓴값");
});

test("promptOverride: env 가 공백뿐이면 fallback 을 준다", () => {
  process.env.SR_TEST_KEY = "   ";
  assert.equal(promptOverride("SR_TEST_KEY", "기본값"), "기본값");
});

test("promptOverride: env 앞뒤 공백은 트림한다", () => {
  process.env.SR_TEST_KEY = "  값  ";
  assert.equal(promptOverride("SR_TEST_KEY", "기본값"), "값");
});

test("confluenceSystemPrompt: 기본값은 기존 문구다", () => {
  delete process.env.SR_PROMPT_CONFLUENCE;
  assert.match(confluenceSystemPrompt(), /Broadcom TAC의 SR/);
});

test("confluenceSystemPrompt: SR_PROMPT_CONFLUENCE 로 덮어쓸 수 있다", () => {
  process.env.SR_PROMPT_CONFLUENCE = "커스텀 컨플루언스 지침";
  assert.equal(confluenceSystemPrompt(), "커스텀 컨플루언스 지침");
});
