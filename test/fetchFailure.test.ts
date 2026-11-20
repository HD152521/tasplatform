/**
 * 전송 오류 사유 읽기.
 *
 * 이 모듈이 틀리면 **조용히 정보가 사라진다** — 화면과 감사 로그에 "fetch failed" 만
 * 남고, 다음 사람이 같은 조사를 처음부터 다시 한다. 실제로 첨부 실패 한 건을
 * 그 넉 자 때문에 끝까지 읽지 못했다(2026-11-17).
 *
 * 그래서 재는 것은 둘이다.
 *   1. cause 사슬 **깊은 쪽**의 구체적인 문구가 살아 나오는가.
 *   2. 전송 실패(다시 보내 볼 수 있다)와 그 외(보내도 같다)를 가르는가.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeFetchError, readFetchFailure } from "../lib/fetchFailure.ts";

/** undici 가 실제로 던지는 모양. TypeError 껍데기 + cause 에 libuv 오류. */
function undiciFailure(detail: string, code: string): TypeError {
  const inner = new Error(detail) as Error & { code?: string; syscall?: string };
  inner.code = code;
  inner.syscall = "connect";
  return new TypeError("fetch failed", { cause: inner });
}

/* ------------------------------------------------------------------ *
 * 사슬 읽기
 * ------------------------------------------------------------------ */

test("껍데기를 버리고 cause 의 구체적인 문구를 남긴다", () => {
  const failure = readFetchFailure(undiciFailure("connect ETIMEDOUT 10.0.0.1:443", "ETIMEDOUT"));
  assert.equal(failure.transport, true);
  assert.equal(failure.code, "ETIMEDOUT");
  assert.match(failure.message, /connect ETIMEDOUT 10\.0\.0\.1:443/);
  // 넉 자만 남는 일이 없어야 한다. 이 테스트가 이 모듈의 존재 이유다.
  assert.doesNotMatch(failure.message, /^fetch failed$/);
});

test("코드마다 처방이 다르므로 안내 문구도 다르다", () => {
  const cases: ReadonlyArray<readonly [string, string, RegExp]> = [
    ["getaddrinfo ENOTFOUND supportftp.broadcom.com", "ENOTFOUND", /DNS/],
    ["connect ECONNREFUSED 10.0.0.1:443", "ECONNREFUSED", /거절/],
    ["connect ETIMEDOUT 10.0.0.1:443", "ETIMEDOUT", /시간을 넘겼/],
    ["read ECONNRESET", "ECONNRESET", /중간에 끊겼/],
    ["unable to verify the first certificate", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", /인증서/],
  ];
  const seen = new Set<string>();
  for (const [detail, code, expected] of cases) {
    const failure = readFetchFailure(undiciFailure(detail, code));
    assert.match(failure.message, expected, code);
    assert.equal(failure.transport, true, code);
    seen.add(failure.message);
  }
  assert.equal(seen.size, cases.length, "서로 다른 사유가 같은 문구로 뭉쳐서는 안 된다");
});

test("사슬이 여러 겹이어도 가장 깊은 사유를 쓴다", () => {
  const deep = new Error("socket hang up") as Error & { code?: string };
  deep.code = "ECONNRESET";
  const middle = new Error("other side closed", { cause: deep });
  const top = new TypeError("fetch failed", { cause: middle });
  assert.match(describeFetchError(top), /socket hang up/);
});

test("AggregateError 는 첫 번째 사유를 쓴다 (주소를 여러 개 시도한 경우)", () => {
  const first = new Error("connect ECONNREFUSED 10.0.0.1:443") as Error & { code?: string };
  first.code = "ECONNREFUSED";
  const group = new AggregateError([first], "all attempts failed");
  const top = new TypeError("fetch failed", { cause: group });
  assert.match(describeFetchError(top), /ECONNREFUSED/);
});

test("순환하는 cause 에서 멈춘다", () => {
  const a = new Error("첫째") as Error & { cause?: unknown };
  const b = new Error("둘째", { cause: a });
  a.cause = b; // 서로를 가리킨다
  // 끝나기만 하면 된다. 멈추지 않으면 수집기 회차가 그대로 선다.
  assert.ok(describeFetchError(new TypeError("fetch failed", { cause: a })).length > 0);
});

/* ------------------------------------------------------------------ *
 * 전송 실패와 그 외를 가르기
 *
 * 이 판정이 재시도를 결정한다(lib/crushftp.ts). 틀리면 400 을 세 번 보내거나,
 * 다시 보내면 됐을 것을 한 번에 포기한다.
 * ------------------------------------------------------------------ */

test("우리가 만든 오류는 그대로 둔다 — 다시 보내도 같다", () => {
  const failure = readFetchFailure(new Error("올리지 못했습니다 (HTTP 400)."));
  assert.equal(failure.transport, false);
  assert.equal(failure.message, "올리지 못했습니다 (HTTP 400).");
});

test("시간초과(AbortSignal.timeout)는 전송 실패로 본다", () => {
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  assert.equal(readFetchFailure(timeout).transport, true);
});

test("cause 가 비어도 fetch failed 는 전송 실패다", () => {
  const failure = readFetchFailure(new TypeError("fetch failed"));
  assert.equal(failure.transport, true);
  assert.match(failure.message, /사유를 알 수 없습니다/);
});

test("Error 가 아닌 것도 삼키지 않는다", () => {
  assert.match(describeFetchError("무언가 잘못됐다"), /무언가 잘못됐다/);
  assert.ok(describeFetchError(undefined).length > 0);
  assert.ok(describeFetchError(null).length > 0);
});

test("문구는 DB 칸과 화면에 들어가므로 길이를 자른다", () => {
  const long = undiciFailure("x".repeat(2_000), "ECONNRESET");
  assert.ok(describeFetchError(long).length <= 240);
});
