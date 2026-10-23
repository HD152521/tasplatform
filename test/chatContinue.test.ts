/**
 * 잘린 답 이어 붙이기.
 *
 * 겹침을 잘못 떼면 **멀쩡한 글자가 사라지고**, 안 떼면 같은 구절이 두 번 나온다.
 * 둘 다 사람이 읽는 문서에 그대로 남는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CONTINUATIONS, continuationUser, looksLikeRestart, runWithContinuation, stitchContinuation,
} from "../lib/chatContinue.ts";

test("겹침이 없으면 그대로 붙인다", () => {
  assert.equal(stitchContinuation("앞부분입니다.", "뒷부분입니다."), "앞부분입니다.뒷부분입니다.");
});

// 모델은 자주 직전 몇 글자를 되풀이하며 이어 쓴다.
test("되풀이한 꼬리는 떼고 붙인다", () => {
  const soFar = "조치는 메모리 쿼터를 2G 로 올리는 것이다. 적용 후";
  const chunk = "것이다. 적용 후 해소됐다.";
  // "것이다. 적용 후" 는 아홉 글자라 겹침 경계(여섯)를 넘는다.
  assert.equal(stitchContinuation(soFar, chunk), "조치는 메모리 쿼터를 2G 로 올리는 것이다. 적용 후 해소됐다.");
});

/*
 * **낱말 중간에서 끊긴 경우.** 공백을 끼워 넣으면 명령이 깨진다 — 문서에 그대로 남아
 * 복사해 쓰는 사람이 당한다.
 */
test("낱말 중간에서 끊겨도 공백을 끼우지 않는다", () => {
  assert.equal(stitchContinuation("systemc", "tl restart diego"), "systemctl restart diego");
});

test("조각이 공백으로 시작하면 그 공백은 남긴다", () => {
  assert.equal(stitchContinuation("첫 문장입니다.", " 둘째 문장입니다."), "첫 문장입니다. 둘째 문장입니다.");
});

/*
 * 처음부터 다시 쓴 응답. 붙이면 같은 글이 두 번 나온다.
 */
test("처음부터 다시 쓴 응답은 다시 쓴 쪽을 택한다", () => {
  const soFar = "### 조치\n메모리 쿼터를 올렸습니다. 적용 후";
  const chunk = "### 조치\n메모리 쿼터를 올렸습니다. 적용 후 해소됐습니다. 재발은 없습니다.";
  assert.equal(stitchContinuation(soFar, chunk), chunk);
});

test("다시 쓴 쪽이 더 짧으면 앞 글을 지킨다", () => {
  const soFar = "### 조치\n메모리 쿼터를 올렸고 적용 후 해소됐습니다. 재발은 없었습니다.";
  const chunk = "### 조치\n메모리 쿼터를 올렸고 적용 후";
  assert.equal(stitchContinuation(soFar, chunk), soFar);
});

/*
 * **조금씩 고쳐 쓴 다시 쓰기.** 모델은 다시 쓸 때 글자를 그대로 두지 않는다 — 조사
 * 하나, 어순 하나를 바꾼다. 글자가 똑같은지로만 보면 이게 안 걸려서 그대로 붙었고,
 * 같은 단락이 세 번 들어간 문서가 실제로 나갔다.
 */
test("조사만 바꿔 다시 쓴 응답도 다시 쓴 것으로 본다", () => {
  const soFar = "발생 현상: 백업 실패 원인이 디스크 용량 고갈로 확인되었으며, "
    + "캐시 디렉터리가 용량 대부분을 차지하고 있었습니다. 다음으로";
  const chunk = "발생 현상: 백업 실패 원인으로 디스크 용량 고갈이 확인되었으며, "
    + "캐시 디렉터리가 용량 대부분을 차지하고 있었습니다. 다음으로 정리 절차를 적용했습니다.";
  assert.equal(looksLikeRestart(soFar, chunk), true);
  assert.equal(stitchContinuation(soFar, chunk), chunk, "붙이면 같은 단락이 두 번 나온다");
});

/*
 * 닮음으로 보는 판정은 **반대로도 틀릴 수 있다.** 진짜 이어 쓴 조각을 다시 쓴 것으로
 * 보면 앞 글이나 조각 하나가 통째로 사라진다. 같은 사건을 다루니 낱말은 겹치지만
 * 머리 내용은 다르다.
 */
test("진짜 이어 쓴 조각은 다시 쓴 것으로 보지 않는다", () => {
  const soFar = "발생 현상: 백업 실패 원인이 디스크 용량 고갈로 확인되었으며, "
    + "캐시 디렉터리가 용량 대부분을 차지하고 있었습니다. 조치는";
  const chunk = " 디스크를 늘리고 만료된 산출물을 정리하는 순서로 적용했습니다. "
    + "적용 뒤 사용률이 내려간 것을 확인했습니다.";
  assert.equal(looksLikeRestart(soFar, chunk), false);
  assert.equal(stitchContinuation(soFar, chunk), soFar + chunk);
});

/*
 * **짧은 겹침은 떼지 않는다.** 한국어 조사·마침표 한두 글자는 어디서나 겹친다. 그걸
 * 겹침으로 보고 떼면 멀쩡한 글자가 사라진다.
 */
test("짧은 우연한 겹침은 떼지 않는다", () => {
  const got = stitchContinuation("원인은 디스크였습니다.", "다음으로 조치를 적용했습니다.");
  assert.equal(got, "원인은 디스크였습니다.다음으로 조치를 적용했습니다.");
});

test("빈 조각이면 원문 그대로다", () => {
  assert.equal(stitchContinuation("앞부분", ""), "앞부분");
  assert.equal(stitchContinuation("앞부분", "   \n "), "앞부분");
});

test("앞 글이 비면 조각이 전부다", () => {
  assert.equal(stitchContinuation("", "조각"), "조각");
});

// 이어 쓰라는 지시에는 꼬리만 넣는다 — 전체를 되돌려 보내면 입력이 불어난다.
test("이어 쓰기 지시에는 꼬리만 넣는다", () => {
  const soFar = "가".repeat(1000) + "끝부분입니다";
  const got = continuationUser("원래 지시", soFar, 50);
  assert.ok(got.includes("원래 지시"));
  assert.ok(got.includes("끝부분입니다"));
  assert.ok(!got.includes("가".repeat(100)), "앞 글 전체가 들어갔다");
  assert.match(got, /중간에서 끊겼다/);
  assert.match(got, /그대로 가져다 쓰지 말 것/, "되풀이 금지가 지시에 남아야 한다");
});

/* ------------------------------------------------------------------ *
 * 이어받기 고리
 * ------------------------------------------------------------------ */

/** 미리 정한 답을 순서대로 돌려주는 가짜 백엔드. 받은 사용자 메시지를 기록한다. */
function fakeBackend(replies: ReadonlyArray<{ text: string; truncated: boolean } | Error>) {
  const seen: string[] = [];
  let i = 0;
  const call = async (user: string): Promise<{ text: string; truncated: boolean }> => {
    seen.push(user);
    const reply = replies[i] ?? { text: "", truncated: false };
    i += 1;
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { call, seen };
}

test("안 잘렸으면 한 번만 부른다", async () => {
  const { call, seen } = fakeBackend([{ text: "완성된 글", truncated: false }]);
  const got = await runWithContinuation(call, "지시");
  assert.deepEqual(got, { text: "완성된 글", truncated: false, calls: 1 });
  assert.equal(seen.length, 1);
});

test("잘렸으면 이어받아 붙인다", async () => {
  const { call, seen } = fakeBackend([
    { text: "앞부분입니다. 그리고", truncated: true },
    { text: " 뒷부분입니다.", truncated: false },
  ]);
  const got = await runWithContinuation(call, "지시");
  assert.equal(got.text, "앞부분입니다. 그리고 뒷부분입니다.");
  assert.equal(got.truncated, false);
  assert.equal(got.calls, 2);
  assert.match(seen[1] ?? "", /중간에서 끊겼다/, "두 번째는 이어 쓰기 지시여야 한다");
});

// 끝없이 부르지 않는다. 상한에 걸리면 truncated 로 알린다.
test("이어받기 상한을 넘기지 않는다", async () => {
  const { call, seen } = fakeBackend([
    { text: "하나", truncated: true },
    { text: "둘", truncated: true },
    { text: "셋", truncated: true },
    { text: "넷", truncated: true },
  ]);
  const got = await runWithContinuation(call, "지시", { maxContinuations: 2 });
  assert.equal(seen.length, 3, "처음 + 이어받기 두 번");
  assert.equal(got.calls, 3);
  assert.equal(got.truncated, true, "끝까지 못 썼다는 사실이 남아야 한다");
});

/*
 * **다시 써 오면 거기서 끝낸다.** 더 부르면 횟수만큼 같은 단락이 쌓인다 — 상한을 8로
 * 올린 뒤에는 아홉 번이다. 사람이 읽는 문서라 이게 제일 먼저 눈에 띈다.
 */
test("다시 써 오면 더 이어받지 않는다", async () => {
  let calls = 0;
  const rewriter = async (): Promise<{ text: string; truncated: boolean }> => {
    calls += 1;
    const text = calls === 1
      ? "발생 현상: 백업 실패 원인이 디스크 용량 고갈로 확인되었으며, 정리 절차를"
      : "발생 현상: 백업 실패 원인으로 디스크 용량 고갈이 확인되었으며, 정리 절차를";
    return { text, truncated: true };
  };
  const got = await runWithContinuation(rewriter, "지시");
  assert.equal(calls, 2, "다시 써 온 것을 알았으면 더 부를 이유가 없다");
  assert.equal(got.truncated, true, "끝까지 못 쓴 것은 사실이다");
  assert.equal(
    got.text.split("발생 현상").length - 1, 1,
    "같은 단락이 두 번 들어갔다",
  );
});

/*
 * **마감이 없는 호출부도 끝난다.** 멈추는 쪽은 보통 마감이지만, 마감을 안 넘기는
 * 호출부에서 끝이 안 나는 글을 만나면 횟수 상한이 받아야 한다. 이게 없으면 영원히 돈다.
 */
test("마감이 없으면 기본 횟수 상한에서 멈춘다", async () => {
  let calls = 0;
  const endless = async () => {
    calls += 1;
    return { text: `조각${calls}`, truncated: true };
  };
  const got = await runWithContinuation(endless, "지시");
  assert.equal(calls, MAX_CONTINUATIONS + 1, "처음 한 번 + 이어받기 상한만큼");
  assert.equal(got.calls, MAX_CONTINUATIONS + 1);
  assert.equal(got.truncated, true, "끝까지 못 썼다는 사실이 남아야 한다");
});

/*
 * **마감을 넘기지 않는다.** 요약 라우트 예산이 꽉 차 있어, 이어받기가 새 예산을 쓰면
 * 라우트가 통째로 타임아웃된다 — 그러면 문서가 아예 안 만들어진다.
 */
test("마감이 지났으면 이어받지 않는다", async () => {
  const { call, seen } = fakeBackend([
    { text: "앞부분", truncated: true },
    { text: "뒷부분", truncated: false },
  ]);
  const got = await runWithContinuation(call, "지시", { deadlineMs: Date.now() + 1_000 });
  assert.equal(seen.length, 1, "시간이 없는데 또 불렀다");
  assert.equal(got.text, "앞부분");
  assert.equal(got.truncated, true);
});

test("마감까지 여유가 있으면 이어받는다", async () => {
  const { call, seen } = fakeBackend([
    { text: "앞부분", truncated: true },
    { text: "뒷부분", truncated: false },
  ]);
  const got = await runWithContinuation(call, "지시", { deadlineMs: Date.now() + 120_000 });
  assert.equal(seen.length, 2);
  assert.equal(got.text, "앞부분뒷부분");
});

/*
 * 이어받기 실패는 받은 만큼 쓴다 — 앞부분은 멀쩡하고, 짧은 문서가 아무 문서도 없는
 * 것보다 낫다. 대신 사유를 남긴다(조용히 삼키지 않는다).
 */
test("이어받기가 실패하면 받은 만큼 돌려주고 사유를 남긴다", async () => {
  const { call } = fakeBackend([
    { text: "앞부분만 있습니다", truncated: true },
    new Error("게이트웨이 500"),
  ]);
  const got = await runWithContinuation(call, "지시");
  assert.equal(got.text, "앞부분만 있습니다");
  assert.equal(got.truncated, true);
  assert.match(got.error ?? "", /게이트웨이 500/);
});

// 첫 호출 실패는 던진다. 빈 글을 성공으로 돌려주면 빈 문서가 게시된다.
test("첫 호출이 실패하면 던진다", async () => {
  const { call } = fakeBackend([new Error("토큰 발급 거부")]);
  await assert.rejects(() => runWithContinuation(call, "지시"), /토큰 발급 거부/);
});
