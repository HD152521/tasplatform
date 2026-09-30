import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KOREAN_RATIO,
  TRANSLATE_SYSTEM_PROMPT,
  asTranslateScope,
  caseTranslateTargets,
  cleanTranslation,
  koreanRatio,
  needsTranslation,
  pickTarget,
  translateControl,
  translationKey,
  untranslated,
} from "../lib/caseTranslate.ts";

const NEWLINE = String.fromCharCode(10);
const lines = (...parts: string[]): string => parts.join(NEWLINE);

test("그대로 옮기라고 못박는다", () => {
  assert.match(TRANSLATE_SYSTEM_PROMPT, /요약하거나 줄이거나/);
  assert.match(TRANSLATE_SYSTEM_PROMPT, /원문 그대로 둡니다/);
});

test("한글 비율을 잰다", () => {
  assert.equal(koreanRatio(""), 0);
  assert.equal(koreanRatio("   "), 0);
  assert.equal(koreanRatio("가나다"), 1);
  assert.equal(koreanRatio("abcd"), 0);
  // 공백은 세지 않는다.
  assert.equal(koreanRatio("가 a"), 0.5);
});

test("영문은 번역 대상이다", () => {
  assert.ok(needsTranslation("The Gorouter drops websocket connections after 30 seconds."));
});

// Broadcom 답변 2,605건 중 379건(15%)이 이미 한국어다(APAC 한국인 엔지니어).
// 다시 번역하면 돈만 쓰고 원문이 뭉개진다.
test("이미 한국어인 글은 건너뛴다", () => {
  assert.ok(!needsTranslation("안녕하세요. 확인 후 회신드리겠습니다."));
});

test("빈 글은 번역하지 않는다", () => {
  assert.ok(!needsTranslation(""));
  assert.ok(!needsTranslation("   "));
});

test("영어에 한글이 조금 섞인 글은 번역한다", () => {
  // 인사말만 한국어이고 본문이 영어인 경우 — 읽으려면 번역이 필요하다.
  const text = lines(
    "안녕하세요,",
    "The issue is caused by a known defect in the routing tier configuration.",
    "Please apply the workaround described in the attached document and let us know.",
  );
  assert.ok(koreanRatio(text) < KOREAN_RATIO, String(koreanRatio(text)));
  assert.ok(needsTranslation(text));
});

test("코드펜스와 머리말을 걷어낸다", () => {
  assert.equal(cleanTranslation(lines("```", "본문입니다.", "```")), "본문입니다.");
  assert.equal(cleanTranslation("번역: 본문입니다."), "본문입니다.");
  assert.equal(cleanTranslation(lines("Translation:", "본문입니다.")), "본문입니다.");
});

test("본문 안의 코드블록은 건드리지 않는다", () => {
  const text = lines("아래 명령을 실행하세요.", "```", "cf scale app -i 4", "```", "감사합니다.");
  assert.equal(cleanTranslation(text), text);
});

// ── 글마다의 번역 ────────────────────────────────────────────────────────────
// 실제 케이스 번호와 고객 문장은 쓰지 않는다(이 저장소는 공개). 아래 본문은 지어낸 것이다.

const EN_DESC = "Application instances restart every few minutes after the platform upgrade.";
const EN_REPLY = "Please collect the Diego cell logs and attach them to this case.";
const KO_REPLY = "안녕하세요. 로그 확인 후 회신드리겠습니다. 감사합니다.";

const sampleCase = {
  requestId: 1001,
  descriptionText: EN_DESC,
  threads: [
    { threadId: 11, bodyText: EN_REPLY },
    { threadId: 12, bodyText: KO_REPLY },
    { threadId: 13, bodyText: "   " },
  ],
};

test("번역 대상은 영문 본문과 영문 대화뿐이다", () => {
  const targets = caseTranslateTargets(sampleCase);
  // 한국어 원문(12)과 빈 글(13)은 애초에 대상이 아니다 — 버튼도 나오지 않아야 한다.
  assert.deepEqual(
    targets.map((t) => `${t.scope}:${t.refId}`),
    ["case_desc:1001", "thread:11"],
  );
});

test("최초 등록 본문이 대화보다 앞이다", () => {
  const targets = caseTranslateTargets(sampleCase);
  assert.equal(targets[0]?.scope, "case_desc");
});

test("최초 등록 본문이 한국어면 대상에서 빠진다", () => {
  const targets = caseTranslateTargets({ ...sampleCase, descriptionText: KO_REPLY });
  assert.deepEqual(targets.map((t) => t.scope), ["thread"]);
});

// 한 번 번역한 글을 다시 부르면 돈이 들고 번역문이 미묘하게 달라진다.
test("이미 번역된 글은 다시 부르지 않는다", () => {
  const targets = caseTranslateTargets(sampleCase);
  const have = new Map([[translationKey("thread", 11), "이미 저장된 번역문"]]);
  assert.deepEqual(
    untranslated(targets, have).map((t) => `${t.scope}:${t.refId}`),
    ["case_desc:1001"],
  );
});

test("전부 번역되어 있으면 남는 것이 없다", () => {
  const targets = caseTranslateTargets(sampleCase);
  const have = new Set(targets.map((t) => translationKey(t.scope, t.refId)));
  assert.deepEqual(untranslated(targets, have), []);
});

test("번역 키는 DB 조회가 쓰는 모양과 같다", () => {
  assert.equal(translationKey("thread", 11), "thread:11");
});

test("한 건만 고를 때 케이스 밖의 번호는 고르지 못한다", () => {
  const targets = caseTranslateTargets(sampleCase);
  assert.equal(pickTarget(targets, "thread", 11)?.text, EN_REPLY);
  // 다른 케이스의 대화 번호로 부르면 번역되지 않는다(케이스 경계).
  assert.equal(pickTarget(targets, "thread", 999), null);
  // 한국어 원문도 고를 수 없다 — 버튼이 없으니 호출도 없어야 한다.
  assert.equal(pickTarget(targets, "thread", 12), null);
});

test("모르는 scope 는 받지 않는다", () => {
  assert.equal(asTranslateScope("thread"), "thread");
  assert.equal(asTranslateScope("case_desc"), "case_desc");
  assert.equal(asTranslateScope("kb_title"), null);
  assert.equal(asTranslateScope(null), null);
});

test("한국어 원문인 글은 버튼 대신 이유를 적는다", () => {
  const control = translateControl({
    translatable: false, hasTranslation: false, showingKorean: false,
  });
  assert.equal(control.kind, "korean");
  assert.match(control.label, /한국어/);
});

test("번역이 없으면 번역 버튼이다", () => {
  assert.deepEqual(
    translateControl({ translatable: true, hasTranslation: false, showingKorean: false }),
    { kind: "translate", label: "번역" },
  );
});

// 위쪽 "전체 번역" 을 돌린 뒤 개별 버튼이 "번역" 으로 남아 있으면 같은 글을 또 부른다.
test("이미 번역된 글의 버튼은 원문 보기로 바뀐다", () => {
  assert.deepEqual(
    translateControl({ translatable: true, hasTranslation: true, showingKorean: true }),
    { kind: "toggle", label: "원문 보기" },
  );
  assert.deepEqual(
    translateControl({ translatable: true, hasTranslation: true, showingKorean: false }),
    { kind: "toggle", label: "한국어 보기" },
  );
});
