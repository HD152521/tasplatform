import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPayload, detectKind, formatFailure, formatReplies } from "../lib/notify.ts";

const REPLY = {
  requestId: 37066647,
  caseLabel: "37066647",
  subject: "Spring Cloud Gateway Crash During TAS Upgrade",
};

test("주소로 메신저 종류를 알아낸다", () => {
  assert.equal(detectKind("https://hooks.slack.com/services/T/B/x"), "slack");
  assert.equal(detectKind("https://outlook.webhook.office.com/webhookb2/x"), "teams");
  assert.equal(detectKind("https://discord.com/api/webhooks/1/x"), "discord");
  assert.equal(detectKind("https://example.com/hook"), "json");
});

test("메신저마다 본문 필드를 맞춘다", () => {
  assert.deepEqual(buildPayload("slack", "안녕"), { text: "안녕" });
  assert.deepEqual(buildPayload("discord", "안녕"), { content: "안녕" });
  assert.deepEqual(buildPayload("json", "안녕"), { text: "안녕" });
});

// Teams 는 줄바꿈을 두 번 써야 실제로 줄이 바뀐다.
test("Teams 는 MessageCard 로 감싸고 줄바꿈을 늘린다", () => {
  const payload = buildPayload("teams", "첫줄\n둘째줄") as Record<string, string>;
  assert.equal(payload["@type"], "MessageCard");
  assert.equal(payload["summary"], "첫줄");
  assert.equal(payload["text"], "첫줄\n\n둘째줄");
});

test("케이스 번호·제목과 링크만 넣는다", () => {
  const text = formatReplies([REPLY]);
  assert.match(text, /새 답변 1건/);
  assert.match(text, /\[37066647\] Spring Cloud Gateway Crash During TAS Upgrade/);
  assert.match(text, /\/cases\/37066647/);
});

// 알림은 "왔다"를 알리는 것이고, 읽는 것은 화면에서 한다.
test("답변 내용·작성자·시각은 넣지 않는다", () => {
  const text = formatReplies([
    { ...REPLY, ...{ author: "Broadcom Internal", preview: "We reviewed the logs" } },
  ]);
  assert.ok(!text.includes("Broadcom Internal"), text);
  assert.ok(!text.includes("reviewed the logs"), text);
});

test("한 건은 제목 줄과 링크 줄로만 이뤄진다", () => {
  const body = formatReplies([REPLY]).split("\n").filter((line) => line.trim() !== "");
  // 머리말 + 제목 + 링크
  assert.deepEqual(body, [
    "Broadcom 새 답변 1건",
    "[37066647] Spring Cloud Gateway Crash During TAS Upgrade",
    "http://localhost:3000/cases/37066647",
  ]);
});

test("건수가 많으면 앞의 몇 건만 적고 나머지는 수만 밝힌다", () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ ...REPLY, caseLabel: `case${i}` }));
  const text = formatReplies(many, 3);
  assert.match(text, /새 답변 15건/);
  assert.match(text, /… 외 12건/);
  assert.ok(text.includes("case2"), "앞 3건은 들어간다");
  assert.ok(!text.includes("case5"), "나머지는 빠진다");
});

// 조용히 멈춘 것을 '답변 없음'으로 오해하면 안 된다. 이 문장이 알림의 핵심이다.
test("실패 알림은 '새 답변 없음'이 아님을 못박는다", () => {
  const text = formatFailure("session", "세션이 만료되었습니다.");
  assert.match(text, /'새 답변 없음'이 아닙니다/);
  assert.match(text, /세션 만료/);
  assert.match(text, /\/login/);
});

test("일반 실패에는 로그인 안내를 넣지 않는다", () => {
  const text = formatFailure("failed", "네트워크 오류");
  assert.match(text, /수집 실패/);
  assert.match(text, /네트워크 오류/);
  assert.ok(!text.includes("/login"));
});

test("사유가 비어도 알림은 만들어진다", () => {
  const text = formatFailure("failed", "");
  assert.match(text, /수집 실패/);
  assert.ok(!text.includes("사유:"));
});
