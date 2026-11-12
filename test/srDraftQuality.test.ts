/**
 * 풀어 쓴 결과를 받아 보고 판단하기.
 *
 * 이 판단이 틀려도 **화면은 멀쩡해 보인다** — 제목도 제품도 다 채워져 있고 본문만
 * 읽을 수 없다. 실제로 이런 글이 그대로 올라갔다:
 *
 *     Hello Support Team,
 *     마이그레이션 작업하는데 vm에 붙어있던 disk가 기존 az에 계속 남아있음 의돤건지
 *     Questions
 *     1. 마이그레이션 작업하는데 vm에 붙어있던 disk가 기존 az에 계속 남아있음 의돤건지
 *     Thanks,
 *
 * 그래서 규칙을 순수 함수로 떼어 여기서 잠근다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_HANGUL_RATIO,
  MIN_CONTENT_WORDS,
  draftPenalty,
  draftShortfalls,
  hangulRatio,
  shortfallNote,
  shortfallWarning,
  wordCount,
} from "../lib/srDraftQuality.ts";

const NEWLINE = String.fromCharCode(10);
const lines = (...parts: string[]): string => parts.join(NEWLINE);

/** 제대로 풀어 쓴 본문. 여기에 걸리는 것이 없어야 한다. */
const GOOD = lines(
  "Hello Support Team,",
  "",
  "We are running VMware vSphere ESXi in our production environment and we are",
  "currently performing a migration of several virtual machines between availability",
  "zones. After the migration completed, the virtual machine itself is reported in the",
  "new availability zone, but the disk that was attached to it still appears to be",
  "located in the original availability zone.",
  "",
  "We have not changed any storage policy during the migration, and the virtual",
  "machine is running without any visible error. We would like to understand whether",
  "this is the expected behavior of the product.",
  "",
  "Questions",
  "1. Is it expected that an attached disk remains in the original availability zone",
  "   after the virtual machine has been migrated?",
  "2. If it is not expected, how can we move the disk to the new availability zone?",
  "",
  "Thanks,",
);

/* ------------------------------------------------------------------ *
 * 비율
 * ------------------------------------------------------------------ */

test("한글 비율은 한글 대 (한글+영문) 이다", () => {
  assert.equal(hangulRatio("가나다"), 1);
  assert.equal(hangulRatio("abcd"), 0);
  assert.equal(hangulRatio("가나ab"), 0.5);
});

// 숫자·기호가 많은 로그 줄 때문에 비율이 흔들리면 판정이 제품마다 달라진다.
test("숫자와 기호는 비율에 끼지 않는다", () => {
  assert.equal(hangulRatio("1234 !@#$ ..."), 0);
  assert.equal(hangulRatio("가 1234567890"), 1);
});

test("빈 글은 0 이다", () => {
  assert.equal(hangulRatio(""), 0);
  assert.equal(hangulRatio("   "), 0);
});

test("낱말은 영문으로 시작하는 토큰만 센다", () => {
  assert.equal(wordCount("we have two disks"), 4);
  // 숫자·경로만 늘어선 줄을 문장으로 세지 않는다.
  assert.equal(wordCount("10.4.2 / 192.168.0.1 2026-11-12"), 0);
});

/* ------------------------------------------------------------------ *
 * 판정
 * ------------------------------------------------------------------ */

test("제대로 쓴 본문은 걸리지 않는다", () => {
  assert.deepEqual(draftShortfalls(GOOD), []);
});

// 실제로 나간 글. 영문 자리에 한국어가 그대로 실렸고, 길이도 메모 그대로였다.
test("한국어가 그대로 남은 본문을 잡는다", () => {
  const bad = lines(
    "Hello Support Team,",
    "마이그레이션 작업하는데 vm에 붙어있던 disk가 기존 az에 계속 남아있음 의돤건지",
    "Questions",
    "1. 마이그레이션 작업하는데 vm에 붙어있던 disk가 기존 az에 계속 남아있음 의돤건지",
    "Thanks,",
  );
  const got = draftShortfalls(bad);
  assert.ok(got.includes("korean"));
  assert.ok(got.includes("thin"));
});

/*
 * 에러 문구·로그는 **한국어여도 그대로 옮기라고** 지시한다. 인용 한 줄 때문에 지시를
 * 지킨 글을 버리면, 다시 부른 쪽이 그 문구를 영어로 옮겨 적는다 — 받는 쪽이 검색을
 * 못 하게 된다.
 */
test("한국어 에러 문구를 인용한 영문 본문은 잡지 않는다", () => {
  const quoted = lines(
    GOOD,
    "",
    "The UI shows the following message:",
    "  디스크를 이동할 수 없습니다. 대상 데이터스토어를 확인하십시오.",
  );
  assert.ok(hangulRatio(quoted) < MAX_HANGUL_RATIO);
  assert.deepEqual(draftShortfalls(quoted), []);
});

test("영어지만 메모 수준으로 짧으면 잡는다", () => {
  const thin = lines(
    "Hello Support Team,",
    "The disk remains in the original AZ after migration. Is this expected?",
    "Thanks,",
  );
  const got = draftShortfalls(thin);
  assert.deepEqual(got, ["thin"]);
  assert.ok(wordCount(thin) < MIN_CONTENT_WORDS);
});

// 빈 본문은 여기서 판정하지 않는다 — 부르는 쪽이 이미 "비어 있다" 로 거절한다.
test("빈 본문은 모자람으로 세지 않는다", () => {
  assert.deepEqual(draftShortfalls(""), []);
  assert.deepEqual(draftShortfalls("   "), []);
});

/* ------------------------------------------------------------------ *
 * 둘 중 고르기
 * ------------------------------------------------------------------ */

test("모자람이 적은 쪽이 낫다", () => {
  const good = draftPenalty({ subject: "[A] B", content: GOOD });
  const thin = draftPenalty({
    subject: "[A] B",
    content: "Hello Support Team, The disk stays. Thanks,",
  });
  assert.equal(good, 0);
  assert.ok(thin > good);
});

/*
 * 비어 있는 것은 어떤 모자람보다 나쁘다. 제목이나 본문이 비면 등록 자체가 막히므로,
 * "짧지만 올릴 수 있는 글" 을 "비어 있는 글" 로 갈아치우면 막다른 길이 된다.
 */
test("비어 있는 쪽은 어떤 모자람보다 나쁘다", () => {
  const empty = draftPenalty({ subject: "", content: GOOD });
  const bothBad = draftPenalty({ subject: "[A] B", content: "짧다" });
  assert.ok(empty > bothBad);
  assert.equal(draftPenalty({ subject: "[A] B", content: "" }), empty);
});

/* ------------------------------------------------------------------ *
 * 다시 부를 때 / 화면에 적을 때
 * ------------------------------------------------------------------ */

test("모자란 것만 집어 말한다", () => {
  const korean = shortfallNote(["korean"]);
  assert.match(korean, /영어로만 씁니다/);
  assert.ok(!korean.includes("메모 수준으로 짧습니다"));

  const thin = shortfallNote(["thin"]);
  assert.match(thin, /완전한 문장으로/);
  assert.ok(!thin.includes("영어로만 씁니다"));
});

test("둘 다 모자라면 둘 다 말한다", () => {
  const both = shortfallNote(["korean", "thin"]);
  assert.match(both, /영어로만 씁니다/);
  assert.match(both, /완전한 문장으로/);
});

// 지어내지 말라는 지시는 다시 부를 때도 풀리지 않아야 한다.
test("다시 부를 때도 지어내지 말라고 붙인다", () => {
  assert.match(shortfallNote(["thin"]), /없는 사실은 그래도 만들지 않습니다/);
});

test("모자란 것이 없으면 덧붙이지 않는다", () => {
  assert.equal(shortfallNote([]), "");
  assert.equal(shortfallWarning([]), "");
});

// 두 번 불러도 한국어가 남았으면 사람이 올리기 전에 봐야 한다. 이 글은 그대로
// 벤더에게 나가고, 화면에서는 멀쩡해 보인다.
test("한국어가 남은 것은 화면에 말한다", () => {
  assert.match(shortfallWarning(["korean"]), /한국어가 남아 있습니다/);
  assert.match(shortfallWarning(["korean", "thin"]), /본문을 확인하세요/);
});

/*
 * 짧은 것은 **말하지 않는다.** 물어볼 것이 정말 한 줄인 SR 도 있다 — 맞게 쓴 글에도
 * 경고가 뜨면 사람은 경고를 읽지 않게 되고, 정작 한국어가 남은 날에도 지나친다.
 * 짧다는 판정은 다시 한 번 부르는 데까지만 쓴다.
 */
test("짧은 것은 다시 부를 근거로만 쓰고 화면에는 올리지 않는다", () => {
  assert.deepEqual(draftShortfalls("Hello Support Team, Short. Thanks,"), ["thin"]);
  assert.equal(shortfallWarning(["thin"]), "");
});
