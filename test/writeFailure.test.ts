/**
 * 쓰기 실패 문구 규칙.
 *
 * 세션 만료는 이 도구에서 정상적으로 일어나는 실패다(공용 계정). 그때는 **할 일과
 * 글이 남아 있다는 사실**까지 말해야 하고, 세션과 무관한 실패에는 **붙이면 안 된다** —
 * 망 오류에 "로그인하세요" 가 붙으면 엉뚱한 곳을 판다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSessionFailure, writeFailureText } from "../lib/writeFailure.ts";

test("세션 만료만 세션 실패로 본다", () => {
  assert.equal(isSessionFailure("session"), true);
  assert.equal(isSessionFailure("failed"), false);
  assert.equal(isSessionFailure(undefined), false);
});

test("세션 만료에는 할 일과 글 보관 사실을 덧붙인다", () => {
  const text = writeFailureText(
    { code: "session", message: "세션이 만료되었습니다." },
    "전송에 실패했습니다.",
  );
  assert.ok(text.startsWith("세션이 만료되었습니다."));
  assert.match(text, /보관/, "글이 남아 있다는 말이 있어야 한다");
  assert.match(text, /refresh/, "세션을 되살리는 방법이 있어야 한다");
});

// 망 오류·종료된 케이스 같은 실패에 로그인 안내가 붙으면 엉뚱한 곳을 판다.
test("세션과 무관한 실패에는 아무것도 덧붙이지 않는다", () => {
  const text = writeFailureText(
    { code: "failed", message: "종료된 케이스에는 답변할 수 없습니다." },
    "전송에 실패했습니다.",
  );
  assert.equal(text, "종료된 케이스에는 답변할 수 없습니다.");
});

test("문구가 없으면 기본 문장을 쓴다", () => {
  assert.equal(writeFailureText({}, "전송에 실패했습니다."), "전송에 실패했습니다.");
  assert.equal(writeFailureText({ message: "   " }, "전송에 실패했습니다."), "전송에 실패했습니다.");
});

// 문구가 비었어도 세션 만료면 안내는 붙어야 한다 — 할 일을 모르는 것이 문제였다.
test("문구가 없는 세션 만료에도 안내는 붙는다", () => {
  const text = writeFailureText({ code: "session" }, "전송에 실패했습니다.");
  assert.ok(text.startsWith("전송에 실패했습니다."));
  assert.match(text, /보관/);
});
