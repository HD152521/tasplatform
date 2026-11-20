/**
 * 로그인 실패 사유 판정.
 *
 * 이 판정이 틀리면 둘 중 하나가 일어난다.
 *
 *   - 거절을 못 알아보면 → 틀린 비밀번호를 15분마다 계속 보낸다(계정 잠김).
 *   - 멀쩡한 화면을 거절로 읽으면 → 수집이 24시간 멈춘다.
 *
 * 그래서 **실제로 나올 수 있는 문구**를 그대로 넣어 잠근다. 특히 안내문("계정이 잠긴
 * 경우에는…")을 오류로 읽지 않는지가 중요하다 — 로그인 화면에는 그런 문장이 늘 있다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LoginAttemptError,
  OtpRequiredError,
  classifyLoginText,
  outcomeOf,
  rejectionMessage,
} from "../lib/loginOutcome.ts";

/* ------------------------------------------------------------------ *
 * 거절 — 다시 보내면 IdP 실패 횟수만 오른다
 * ------------------------------------------------------------------ */

test("자격 거절 문구를 알아본다", () => {
  const samples = [
    "Invalid username or password.",
    "Sign in failed!",
    "Unable to sign in",
    "The username or password you entered is incorrect.",
    "Authentication failed",
    "아이디 또는 비밀번호가 맞지 않습니다",
  ];
  for (const text of samples) {
    const verdict = classifyLoginText(text);
    assert.notEqual(verdict, null, `못 알아봤다: ${text}`);
    assert.equal(verdict?.kind, "rejected", text);
  }
});

test("거절된 줄을 근거로 남긴다", () => {
  const verdict = classifyLoginText("Broadcom Support\n\nSign in failed!\nTry again.");
  assert.equal(verdict?.kind, "rejected");
  assert.equal(verdict?.hint, "Sign in failed!");
});

/* ------------------------------------------------------------------ *
 * 잠김 · 만료 — 더 시도해도 의미가 없다
 * ------------------------------------------------------------------ */

test("계정 잠김을 따로 구분한다", () => {
  for (const text of [
    "Your account has been locked. Contact your administrator.",
    "Your account is locked out.",
    "This account is temporarily locked.",
    "Too many failed login attempts.",
    "계정이 잠겼습니다",
  ]) {
    assert.equal(classifyLoginText(text)?.kind, "locked", text);
  }
});

test("비밀번호 만료를 따로 구분한다", () => {
  for (const text of [
    "Your password has expired.",
    "You must change your password before continuing.",
    "비밀번호가 만료되었습니다",
  ]) {
    assert.equal(classifyLoginText(text)?.kind, "expired", text);
  }
});

test("잠김이 일반 거절보다 우선한다", () => {
  // 한 화면에 둘이 같이 뜨는 일이 있다. 거절로 접으면 잠긴 계정을 계속 찔러
  // 잠금 시간만 늘린다.
  const verdict = classifyLoginText("Sign in failed!\nYour account has been locked.");
  assert.equal(verdict?.kind, "locked");
});

/* ------------------------------------------------------------------ *
 * 안내문을 오류로 읽지 않는다 — 여기가 가장 위험한 오탐이다
 * ------------------------------------------------------------------ */

test("조건절 안내문은 무시한다", () => {
  for (const text of [
    "If your account is locked, contact your administrator.",
    "Your password will expire in 7 days.",
    "Should your password be incorrect, you may reset it below.",
    "계정이 잠긴 경우에는 관리자에게 문의하세요.",
  ]) {
    assert.equal(classifyLoginText(text), null, `오탐: ${text}`);
  }
});

test("평범한 로그인 화면은 아무것도 아니다", () => {
  const page = [
    "Broadcom Support Portal",
    "Sign in",
    "Email address",
    "Password",
    "Remember me",
    "Forgot password?",
    "Don't have an account? Register",
  ].join("\n");
  assert.equal(classifyLoginText(page), null);
});

test("빈 화면은 판정하지 않는다", () => {
  assert.equal(classifyLoginText(""), null);
  assert.equal(classifyLoginText("   \n  \n"), null);
});

test("근거 문장은 길이를 자른다", () => {
  const long = `Sign in failed ${"x".repeat(500)}`;
  const hint = classifyLoginText(long)?.hint ?? "";
  assert.ok(hint.length <= 161, `너무 길다: ${hint.length}`);
  assert.ok(hint.endsWith("…"));
});

/* ------------------------------------------------------------------ *
 * 사람 말로 바꾸기
 * ------------------------------------------------------------------ */

test("종류별로 다른 안내를 낸다", () => {
  const locked = rejectionMessage({ kind: "locked", hint: "locked" });
  const expired = rejectionMessage({ kind: "expired", hint: "expired" });
  const rejected = rejectionMessage({ kind: "rejected", hint: "nope" });
  assert.match(locked, /잠긴/);
  assert.match(expired, /만료/);
  assert.match(rejected, /맞지 않/);
  assert.equal(new Set([locked, expired, rejected]).size, 3);
});

/* ------------------------------------------------------------------ *
 * 오류 → 카운터가 먹을 사실
 * ------------------------------------------------------------------ */

test("OTP 는 실패가 아니다 — 비밀번호가 통과했다는 뜻", () => {
  const facts = outcomeOf(new OtpRequiredError());
  assert.equal(facts.outcome, "otp");
  assert.equal(facts.passwordSubmitted, true);
});

test("거절은 비밀번호 제출 여부와 사유를 그대로 들고 온다", () => {
  const facts = outcomeOf(
    new LoginAttemptError("rejected", "아이디 또는 비밀번호가 맞지 않습니다.", {
      passwordSubmitted: true,
      hint: "Sign in failed!",
    }),
  );
  assert.equal(facts.outcome, "rejected");
  assert.equal(facts.passwordSubmitted, true);
  assert.match(facts.reason, /맞지 않/);
});

test("모르는 오류는 비밀번호 실패로 세지 않는다", () => {
  // 망 장애가 계정 차단으로 번지면 안 된다.
  const facts = outcomeOf(new Error("getaddrinfo ENOTFOUND access.broadcom.com"));
  assert.equal(facts.outcome, "failed");
  assert.equal(facts.passwordSubmitted, false, "모르는 것을 세면 멀쩡한 계정이 막힌다");
});
