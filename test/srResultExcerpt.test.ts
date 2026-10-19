/**
 * 정리 문서에서 결과 부분 뽑기.
 *
 * Jira 댓글에 두세 줄을 남기려는 것이다. **섹션 이름으로 찾지 않는다** — 한때 Confluence
 * 변환기가 "아는 섹션 이름 네 개" 만 보다가, 프롬프트의 섹션 이름이 바뀌어 네 개가
 * 하나도 안 맞게 되면서 `### 문제` 가 글자 그대로 게시됐다. 그래서 **모양**(마지막
 * 헤딩)으로 찾는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resultExcerpt } from "../lib/srResultExcerpt.ts";
import { CONFLUENCE_SECTIONS } from "../lib/summaryPrompt.ts";

const lines = (...rows: string[]): string => rows.join("\n");

test("마지막 헤딩의 본문을 가져온다", () => {
  const got = resultExcerpt(lines(
    "### 문제",
    "앱이 죽습니다.",
    "",
    "### 해결 제안 및 조치 방안",
    "메모리 쿼터를 2G 로 올리면 해소됩니다.",
    "재현 조건은 동시 접속 500 이상입니다.",
  ));
  assert.equal(got, "메모리 쿼터를 2G 로 올리면 해소됩니다.\n재현 조건은 동시 접속 500 이상입니다.");
});

/*
 * **섹션 이름이 바뀌어도 따라와야 한다.** 이름 목록을 들고 있으면 프롬프트가 바뀔 때
 * 조용히 깨진다.
 */
test("섹션 이름이 무엇이든 마지막 것을 가져온다", () => {
  for (const name of ["해결 제안 및 조치 방안", "최종 결과", "조치", "아무 제목"]) {
    const got = resultExcerpt(lines("### 문제", "x", "", `### ${name}`, "이렇게 끝났습니다."));
    assert.equal(got, "이렇게 끝났습니다.", `${name} 에서 어긋났다`);
  }
});

/*
 * 지금 프롬프트의 **실제 마지막 섹션**으로도 되는지 본다. 프롬프트가 바뀌면 이 시험이
 * 같이 따라오므로, 이름을 베껴 쓴 자리가 없는지 지켜 준다.
 */
test("지금 프롬프트의 마지막 섹션에서도 된다", () => {
  const last = CONFLUENCE_SECTIONS.filter((s) => s.heading !== "").at(-1)?.heading ?? "";
  assert.notEqual(last, "", "전제: 헤딩이 있는 섹션이 하나는 있다");
  const got = resultExcerpt(lines("### 문제", "x", "", `### ${last}`, "결론입니다."));
  assert.equal(got, "결론입니다.");
});

test("글머리 기호는 떼어낸다", () => {
  const got = resultExcerpt(lines("### 조치", "- 첫째 조치", "* 둘째 조치"));
  assert.equal(got, "첫째 조치\n둘째 조치");
});

// 표는 댓글에서 읽히지 않는다. 가져오지 않는다.
test("표는 가져오지 않는다", () => {
  const got = resultExcerpt(lines(
    "### 조치", "| 항목 | 값 |", "|---|---|", "| a | b |", "조치를 적용했습니다.",
  ));
  assert.equal(got, "조치를 적용했습니다.");
});

test("줄이 많으면 앞의 몇 줄만 쓴다", () => {
  const got = resultExcerpt(lines("### 조치", "1", "2", "3", "4", "5", "6"));
  assert.equal(got.split("\n").length, 4, "줄 수 상한을 넘겼다");
});

test("길면 자르고 말줄임을 붙인다", () => {
  const got = resultExcerpt(lines("### 조치", "가".repeat(500)), 100);
  assert.ok(got.length <= 101, `${got.length}자`);
  assert.ok(got.endsWith("…"));
});

/*
 * 헤딩이 하나도 없는 요약(사람이 쓴 초안 등)도 있다. 빈 댓글을 남기는 것보다 끝부분을
 * 쓰는 편이 낫다.
 */
test("헤딩이 없으면 맨 끝 문단을 쓴다", () => {
  const got = resultExcerpt("첫 문단입니다.\n\n둘째 문단입니다.\n\n끝 문단이 결론입니다.");
  assert.equal(got, "끝 문단이 결론입니다.");
});

test("빈 글이면 빈 결과다", () => {
  assert.equal(resultExcerpt(""), "");
  assert.equal(resultExcerpt("\n\n   \n"), "");
  // 헤딩만 있고 본문이 없는 경우.
  assert.equal(resultExcerpt("### 조치\n"), "");
});

// 이모지가 경계에 걸리면 깨진 글자가 댓글로 나간다.
test("자를 때 이모지를 쪼개지 않는다", () => {
  const got = resultExcerpt(lines("### 조치", "가".repeat(98) + "🚨🚨"), 100);
  for (let i = 0; i < got.length; i += 1) {
    const code = got.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = got.charCodeAt(i + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, `${i}번째 글자가 짝을 잃었다`);
    }
  }
});

/*
 * ## 코드 블록 안을 제목으로 보면 안 된다
 *
 * 마지막 섹션(해결 제안·조치)은 명령과 설정을 코드 블록으로 옮기게 되어 있다. 그 안의
 * 셸 주석 `# ...` 을 헤딩으로 오인하면 **마지막 헤딩이 그 줄로 옮겨가서**, 댓글에 명령
 * 한두 줄과 닫는 울타리만 들어간다.
 */
test("코드 블록 안의 # 은 제목이 아니다", () => {
  const got = resultExcerpt(lines(
    "### 문제",
    "앱이 죽습니다.",
    "",
    "### 조치",
    "메모리 쿼터를 올렸습니다.",
    "```bash",
    "# 서비스 재시작",
    "systemctl restart diego",
    "```",
  ));
  assert.equal(got, "메모리 쿼터를 올렸습니다.", `가져온 것: ${JSON.stringify(got)}`);
});

// 코드 블록으로 시작하는 섹션이면 울타리 줄이 평문으로 새 나가지 않아야 한다.
test("울타리 줄과 명령은 댓글에 넣지 않는다", () => {
  const got = resultExcerpt(lines(
    "### 조치",
    "```bash",
    "cf scale app -m 2G",
    "```",
    "적용 후 해소됐습니다.",
  ));
  assert.equal(got, "적용 후 해소됐습니다.");
  assert.doesNotMatch(got, /```/);
  assert.doesNotMatch(got, /cf scale/);
});

/*
 * 글머리 기호를 뗄 때 **기호 뒤 공백을 요구한다.** 안 그러면 요약이 자주 쓰는 모양이
 * 훼손된다.
 */
test("굵게 표시와 옵션 글자를 훼손하지 않는다", () => {
  const got = resultExcerpt(lines("### 조치", "**조치 방안:** 쿼터 상향", "--force 를 썼습니다"));
  assert.match(got, /\*\*조치 방안:\*\*/, `가져온 것: ${JSON.stringify(got)}`);
  assert.match(got, /--force/);
});
