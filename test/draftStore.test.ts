/**
 * 초안 보존 규칙.
 *
 * 긴 글을 쓰고 보냈을 때 "세션이 만료되었습니다" 가 뜨면, 세션을 고치는 동안 새로고침
 * 한 번에 **쓴 글이 사라졌다.** 그 글을 다시 쓰는 것이 이 도구를 쓰는 이유를 지운다.
 *
 * 저장 자체가 던지는 환경(시크릿 창 등)이 있어, **저장 실패가 글쓰기를 막지 않는지**
 * 까지 잠근다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearDraft, draftKey, loadDraft, saveDraft } from "../lib/draftStore.ts";

/** localStorage 를 흉내 낸다. node:test 에는 브라우저 저장소가 없다. */
function fakeStorage(options: { throwOn?: "get" | "set" | "remove" } = {}) {
  const map = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => {
        if (options.throwOn === "get") throw new Error("막힘");
        return map.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (options.throwOn === "set") throw new Error("막힘");
        map.set(k, v);
      },
      removeItem: (k: string) => {
        if (options.throwOn === "remove") throw new Error("막힘");
        map.delete(k);
      },
    },
  };
  return map;
}

/*
 * 케이스마다 키가 달라야 한다. 한 칸으로 쓰면 다른 케이스를 열었을 때 **남의 글**이 뜬다.
 */
test("자리와 대상마다 키가 다르다", () => {
  assert.notEqual(draftKey("reply", 1), draftKey("reply", 2));
  assert.notEqual(draftKey("reply", 1), draftKey("new", 1));
  assert.ok(draftKey("reply", 1).startsWith("sr-draft:"), "앞가지로 남의 키와 섞이지 않게");
});

test("저장한 글을 그대로 돌려준다", () => {
  fakeStorage();
  const key = draftKey("reply", 37027473);
  saveDraft(key, "쓰던 답변\n둘째 줄");
  assert.equal(loadDraft(key), "쓰던 답변\n둘째 줄");
});

test("없으면 빈 문자열이다", () => {
  fakeStorage();
  assert.equal(loadDraft(draftKey("reply", 1)), "");
});

/*
 * 보낸 뒤 **반드시 지운다.** 남겨 두면 다음에 열 때 이미 보낸 글이 되살아나,
 * 같은 답변을 두 번 보내게 된다.
 */
test("지우면 남지 않는다", () => {
  fakeStorage();
  const key = draftKey("reply", 1);
  saveDraft(key, "보낸 글");
  clearDraft(key);
  assert.equal(loadDraft(key), "");
});

// 빈 글은 저장하지 않고 지운다 — 빈 값이 남으면 "복구할 초안이 있다" 고 오해한다.
test("빈 글은 저장하지 않고 기존 것을 지운다", () => {
  const map = fakeStorage();
  const key = draftKey("reply", 1);
  saveDraft(key, "뭔가");
  saveDraft(key, "   ");
  assert.equal(loadDraft(key), "");
  assert.equal(map.size, 0, "빈 값으로 자리를 차지하면 안 된다");
});

// localStorage 는 보통 5MB 공용이다. 한 글이 다 쓰면 다른 초안이 죽는다.
test("너무 긴 글은 잘라 담는다", () => {
  fakeStorage();
  const key = draftKey("reply", 1);
  saveDraft(key, "가".repeat(200_000));
  assert.equal(loadDraft(key).length, 100_000);
});

/*
 * **저장이 막힌 환경에서도 던지지 않는다.** 시크릿 창이나 저장 차단 설정에서
 * localStorage 접근 자체가 던진다. 초안 보존이 글쓰기를 막으면 안 된다.
 */
test("저장소가 막혀 있어도 던지지 않는다", () => {
  for (const throwOn of ["get", "set", "remove"] as const) {
    fakeStorage({ throwOn });
    const key = draftKey("reply", 1);
    assert.doesNotThrow(() => saveDraft(key, "글"), `${throwOn} 에서 던졌다`);
    assert.doesNotThrow(() => clearDraft(key), `${throwOn} 에서 던졌다`);
    assert.doesNotThrow(() => loadDraft(key), `${throwOn} 에서 던졌다`);
  }
});

/*
 * 읽기나 쓰기가 막히면 **복구할 초안이 없는 것처럼** 동작한다 — 기능이 없는 셈이고,
 * 글쓰기는 그대로 된다.
 *
 * 지우기만 막힌 경우는 값이 남는다. 지울 방법이 없으니 그게 맞다. 실제 브라우저에서는
 * 세 가지가 함께 막히므로(저장소 차단) 이 조합은 거의 없다.
 */
test("읽기·쓰기가 막히면 초안이 없는 것과 같다", () => {
  for (const throwOn of ["get", "set"] as const) {
    fakeStorage({ throwOn });
    const key = draftKey("reply", 1);
    saveDraft(key, "글");
    assert.equal(loadDraft(key), "", `${throwOn} 에서 빈 값이어야`);
  }
});
