import { test } from "node:test";
import assert from "node:assert/strict";
import { DUP_WINDOW_MS, condenseBody, dedupeThreads, stripSignatureBlock } from "../lib/srSource.ts";

const NEWLINE = String.fromCharCode(10);
const lines = (...parts: string[]): string => parts.join(NEWLINE);

/**
 * 답변의 "모양"만 본뜬 합성 데이터다.
 *
 * 실제 케이스 번호·담당자명·고객 문장을 넣지 않는다. 이 저장소는 공개이고,
 * 케이스 번호와 담당자명이 붙으면 어느 고객사의 어떤 장애였는지 특정할 단서가 된다.
 */
const ANSWER = lines(
  "Hi Team,",
  "",
  "The checksum offloading setting must also be applied to the overlay interface.",
  "",
  "Thanks,",
  "",
  "Sample Engineer",
  "Product support engineer | APAC Tanzu Support",
  "VMware by Broadcom",
  "sample.engineer@example.com | broadcom.com",
);

const POINT = "The checksum offloading setting must also be applied to the overlay interface.";

/* ------------------------------------------------------------------ *
 * 중복 걷어내기
 * ------------------------------------------------------------------ */

// 포털에 같은 답변이 두 건으로 들어 있다. 실측 중앙 간격은 20초였다.
test("같은 화자가 몇 초 간격으로 올린 같은 본문은 하나만 남긴다", () => {
  const kept = dedupeThreads([
    { isOurs: false, atMs: 1_000_000, body: POINT },
    { isOurs: false, atMs: 1_011_500, body: POINT },
  ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.atMs, 1_000_000, "먼저 온 것을 남겨야 시간 순서가 어긋나지 않는다");
});

// 줄바꿈만 다른 두 건도 같은 본문이다.
test("공백·줄바꿈만 다르면 같은 본문으로 본다", () => {
  const kept = dedupeThreads([
    { isOurs: false, atMs: 0, body: lines("a", "b") },
    { isOurs: false, atMs: 5_000, body: "a  b" },
  ]);
  assert.equal(kept.length, 1);
});

// 실측 최대 간격은 42일이었다. 같은 문구를 다시 보낸 정상 재발송이다.
test("시간창을 벗어난 같은 본문은 재발송이므로 남긴다", () => {
  const kept = dedupeThreads([
    { isOurs: false, atMs: 0, body: POINT },
    { isOurs: false, atMs: DUP_WINDOW_MS + 1, body: POINT },
  ]);
  assert.equal(kept.length, 2);
});

// 화자가 다르면 본문이 같아도 다른 사건이다(고객이 TAC 문장을 그대로 인용하는 일이 있다).
test("화자가 다르면 본문이 같아도 남긴다", () => {
  const kept = dedupeThreads([
    { isOurs: false, atMs: 0, body: POINT },
    { isOurs: true, atMs: 1_000, body: POINT },
  ]);
  assert.equal(kept.length, 2);
});

// 시각을 모르면 중복인지 재발송인지 가릴 근거가 없다.
test("시각이 없는 건은 손대지 않는다", () => {
  const kept = dedupeThreads([
    { isOurs: false, body: POINT },
    { isOurs: false, body: POINT },
  ]);
  assert.equal(kept.length, 2);
});

test("중복이 없으면 원래 순서를 그대로 돌려준다", () => {
  const input = [
    { isOurs: true, atMs: 0, body: "질문" },
    { isOurs: false, atMs: 1_000, body: "답변" },
    { isOurs: true, atMs: 2_000, body: "확인" },
  ];
  assert.deepEqual(dedupeThreads(input), input);
});

/* ------------------------------------------------------------------ *
 * 서명 걷어내기
 * ------------------------------------------------------------------ */

test("맺음말 뒤가 연락처뿐이면 서명 블록을 잘라낸다", () => {
  const kept = stripSignatureBlock(ANSWER);
  assert.ok(kept.includes(POINT), kept);
  assert.ok(!kept.includes("broadcom.com"), kept);
  assert.ok(!kept.includes("Sample Engineer"), kept);
});

// 본문 한가운데의 "Thanks," 로 뒷부분을 통째로 버리면 요점을 잃는다.
test("본문 중간의 맺음말은 자르지 않는다", () => {
  const text = lines(
    "Thanks,",
    "",
    "We reviewed the capture and found a one second delay on the outbound request.",
    "",
    "Please run the diagnostic on both foundations.",
  );
  const kept = stripSignatureBlock(text);
  assert.ok(kept.includes("one second delay"), kept);
  assert.ok(kept.includes("Please run the diagnostic"), kept);
});

test("맺음말이 없어도 반복 안내 문단은 걷어낸다", () => {
  const text = lines(
    POINT,
    "",
    "As part of our commitment to providing the best possible customer service,",
    "we may send you a survey to receive your highly valued feedback on this case.",
    "",
    "The workaround remains valid until the fix ships.",
  );
  const kept = stripSignatureBlock(text);
  assert.ok(kept.includes(POINT), kept);
  assert.ok(kept.includes("workaround remains valid"), kept);
  assert.ok(!kept.includes("survey"), kept);
});

test("서명이 없는 본문은 그대로 둔다", () => {
  const text = lines("First line.", "", "Second line.");
  assert.equal(stripSignatureBlock(text), text);
});

// 덜 자르는 쪽이 안전하다. 전부 서명이면 자르지 않은 원문을 쓴다.
test("전부 서명이면 원문을 돌려준다", () => {
  const text = lines("Thanks,", "", "Sample Engineer", "sample.engineer@example.com");
  assert.equal(stripSignatureBlock(text), "");
  assert.equal(condenseBody(text), text);
});

test("condenseBody 는 서명을 걷어낸 본문을 돌려준다", () => {
  assert.equal(condenseBody(ANSWER), lines("Hi Team,", "", POINT));
});
