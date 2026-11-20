/**
 * `@`·`#` 자동완성이 **언제 떠야 하는가**.
 *
 * 이 판정이 틀리면 둘 중 하나가 된다.
 *   - 떠야 할 때 안 뜬다 → 사람이 외워서 적고, 틀린 태그는 조용히 "성격" 으로 떨어져
 *     Jira 제목의 대괄호가 빈다.
 *   - 안 떠야 할 때 뜬다 → 이메일 주소를 적는 중에 팀원 목록이 가로막는다.
 *
 * 그래서 커서 위치까지 포함해 잠근다. 화면 조각(목록 렌더)은 빼고 판정만 본다 —
 * 판정이 순수 함수라서 가능하다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeToken,
  applySuggestion,
  filterSuggestions,
  memberSuggestions,
  tagSuggestions,
} from "../lib/tokenSuggest.ts";

const BOTH = ["@", "#"] as const;

/** `|` 가 커서 자리다. 적기 쉽게 하려고 쓴다. */
function at(textWithCaret: string, triggers: readonly ("@" | "#")[] = BOTH) {
  const caret = textWithCaret.indexOf("|");
  assert.notEqual(caret, -1, "커서 표시(|)가 없다");
  return activeToken(textWithCaret.replace("|", ""), caret, triggers);
}

/* ------------------------------------------------------------------ *
 * 떠야 하는 때
 * ------------------------------------------------------------------ */

test("# 만 쳤으면 전체 목록이다(빈 질의)", () => {
  const got = at("점검 #|");
  assert.equal(got?.trigger, "#");
  assert.equal(got?.query, "");
});

test("@ 만 쳤어도 뜬다", () => {
  const got = at("@|");
  assert.equal(got?.trigger, "@");
  assert.equal(got?.query, "");
});

test("적는 중인 글자를 질의로 돌려준다", () => {
  assert.equal(at("점검 #운|")?.query, "운");
  assert.equal(at("@용식|")?.query, "용식");
});

test("줄 맨 앞의 토큰도 잡는다", () => {
  const got = at("#운영|");
  assert.equal(got?.trigger, "#");
  assert.equal(got?.start, 0);
});

test("토큰을 넣을 자리(start)를 알려 준다", () => {
  // 고른 값으로 갈아 끼우려면 `#` 의 위치를 알아야 한다.
  const got = at("11/25 점검 #운|");
  assert.equal(got?.start, "11/25 점검 ".length);
});

test("가운데를 고치는 중에도 뜬다", () => {
  // 커서 **앞쪽만** 본다. 뒤에 글자가 더 있어도 지금 적는 토큰이 기준이다.
  const got = at("#운| #DR 정기점검");
  assert.equal(got?.trigger, "#");
  assert.equal(got?.query, "운");
});

test("여러 토큰 중 커서가 있는 것만 본다", () => {
  const got = at("#운영 @민|");
  assert.equal(got?.trigger, "@");
  assert.equal(got?.query, "민");
});

/* ------------------------------------------------------------------ *
 * 뜨면 안 되는 때
 * ------------------------------------------------------------------ */

test("이메일 주소의 @ 는 토큰이 아니다", () => {
  // 낱말 가운데의 @ 다. 여기서 팀원 목록이 뜨면 적는 것을 방해한다.
  assert.equal(at("yongsik@|"), null);
  assert.equal(at("yongsik@example|"), null);
});

test("토큰 뒤에 공백이 오면 그 토큰은 끝났다", () => {
  assert.equal(at("#운영 |"), null);
  assert.equal(at("@용식 정기점검|"), null);
});

test("토큰이 전혀 없으면 null", () => {
  assert.equal(at("11/25 정기점검|"), null);
  assert.equal(at("|"), null);
});

test("허용하지 않은 방아쇠는 뜨지 않는다", () => {
  // 본문 칸은 `@`(멘션)만 받는다 — 본문의 `#` 는 태그가 아니다.
  assert.equal(at("확인 #운|", ["@"]), null);
  assert.equal(at("확인 @용|", ["@"])?.trigger, "@");
});

test("커서가 토큰보다 앞이면 뜨지 않는다", () => {
  assert.equal(at("점검| #운영"), null);
});

test("줄바꿈도 토큰을 끊는다", () => {
  // 본문은 여러 줄이다. 앞 줄의 @ 가 다음 줄까지 이어지면 안 된다.
  assert.equal(activeToken("@용식\n확인", 6, BOTH), null);
  assert.equal(activeToken("@용식\n@민", 8, BOTH)?.query, "민");
});

/* ------------------------------------------------------------------ *
 * 고른 값 끼워넣기
 * ------------------------------------------------------------------ */

test("적던 토큰을 고른 값으로 갈아 끼우고 공백을 붙인다", () => {
  const text = "11/25 점검 #운";
  const token = activeToken(text, text.length, BOTH);
  assert.ok(token !== null);
  const got = applySuggestion(text, token, text.length, "운영");
  assert.equal(got.text, "11/25 점검 #운영");
  assert.equal(got.caret, got.text.length, "커서는 넣은 토큰 뒤로 간다");
});

test("가운데를 고칠 때는 공백을 하나만 둔다", () => {
  const text = "#운 #DR 정기점검";
  // 커서는 '운' 바로 뒤(2)다. 3 은 공백 뒤라 토큰이 이미 끝난 자리다.
  const token = activeToken(text, 2, BOTH);
  assert.ok(token !== null);
  const got = applySuggestion(text, token, 2, "운영");
  assert.equal(got.text, "#운영 #DR 정기점검", "뒤에 이미 공백이 있으므로 더 넣지 않는다");
  assert.equal(got.caret, "#운영".length);
});

test("뒤에 글자가 바로 붙어 있으면 공백을 넣어 가른다", () => {
  const text = "#운정기점검";
  // 커서를 '운' 뒤(2)에 둔다.
  const token = activeToken(text, 2, BOTH);
  assert.ok(token !== null);
  const got = applySuggestion(text, token, 2, "운영");
  assert.equal(got.text, "#운영 정기점검");
});

test("빈 토큰에서 골라도 된다", () => {
  const text = "점검 #";
  const token = activeToken(text, text.length, BOTH);
  assert.ok(token !== null);
  assert.equal(applySuggestion(text, token, text.length, "DR").text, "점검 #DR");
});

/* ------------------------------------------------------------------ *
 * 목록
 * ------------------------------------------------------------------ */

test("# 목록에 망·법인·성격이 모두 있고, 어디로 가는지 적혀 있다", () => {
  const all = tagSuggestions();
  const find = (insert: string) => all.find((s) => s.insert === insert);

  assert.equal(find("운영")?.group, "전산망");
  assert.match(find("운영")?.hint ?? "", /대괄호/);
  assert.equal(find("은행")?.group, "법인");
  assert.match(find("은행")?.hint ?? "", /에픽/);
  assert.match(find("은행")?.hint ?? "", /은/, "줄임말을 알려 준다");
  assert.equal(find("장애")?.group, "성격");
  assert.match(find("장애")?.hint ?? "", /TAS_장애대응/);
});

test("@ 목록은 Jira 미연결도 보여 주고 그 사실을 적는다", () => {
  // 빼면 "왜 저 사람은 안 나오지" 가 된다.
  const got = memberSuggestions([
    { userId: 1, displayName: "안용식", loginId: "yongsik", hasJira: true },
    { userId: 2, displayName: "", loginId: "nolink", hasJira: false },
  ]);
  assert.equal(got[0]?.insert, "안용식");
  assert.equal(got[0]?.hint, "yongsik");
  assert.equal(got[1]?.insert, "nolink", "이름이 없으면 아이디로 넣는다");
  assert.match(got[1]?.hint ?? "", /Jira 미연결/);
});

test("질의가 비면 전부, 앞글자가 맞는 것이 먼저다", () => {
  const all = tagSuggestions();
  assert.equal(filterSuggestions(all, "").length, all.length);

  const got = filterSuggestions(all, "운");
  assert.equal(got[0]?.insert, "운영", "앞글자가 맞는 것이 맨 위여야 한다");
});

test("앞글자로 못 찾으면 가운데 글자까지 본다", () => {
  const all = tagSuggestions();
  // '앙' 은 어느 값으로도 시작하지 않지만 '중앙회' 안에 있다.
  assert.equal(filterSuggestions(all, "앙")[0]?.insert, "중앙회");
});

test("아무것도 안 맞으면 빈 목록이다", () => {
  assert.deepEqual(filterSuggestions(tagSuggestions(), "없는태그zzz"), []);
});
