/**
 * 해결 섹션 뒷정리 — 참고 문서 떼어내기와 소제목 올리기.
 *
 * 실제 게시된 문서가 `조치 방안:` → `참고 공식 문서:` → `조치 효과:` 순이었다.
 * 조치와 효과가 링크 뭉치로 갈라져, 읽는 사람이 URL 목록을 지나 다시 효과를 만났다.
 * 순서를 프롬프트로만 못박는 것은 믿을 수 없으니(실측에서 어겼다) 코드가 옮긴다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REFERENCE_HEADING,
  promoteSubheadings,
  renderReferences,
  splitReferences,
} from "../lib/summarySolution.ts";

const lines = (...rows: string[]): string => rows.join("\n");

/* ------------------------------------------------------------------ *
 * 참고 문서 떼어내기
 * ------------------------------------------------------------------ */

// 이것이 고치려던 모양 그대로다 — 링크가 조치와 효과 **사이에** 끼어 있었다.
test("조치와 효과 사이에 끼인 참고 문서를 떼어낸다", () => {
  const got = splitReferences(lines(
    "조치 방안: 메트릭 엔드포인트를 활성화하도록 안내했습니다.",
    "참고 공식 문서: https://docs.example.com/app-metrics.html",
    "조치 효과: 재배포 후 사용량이 정상 표시됩니다.",
  ));
  assert.deepEqual(got.references, ["https://docs.example.com/app-metrics.html"]);
  assert.equal(got.body, lines(
    "조치 방안: 메트릭 엔드포인트를 활성화하도록 안내했습니다.",
    "조치 효과: 재배포 후 사용량이 정상 표시됩니다.",
  ));
});

test("라벨 줄 아래로 이어지는 주소 목록을 모은다", () => {
  const got = splitReferences(lines(
    "조치 효과: 정상 표시됩니다.",
    "참고 공식 문서:",
    "- https://docs.example.com/a.html",
    "- https://docs.example.com/b.html",
  ));
  assert.deepEqual(got.references, [
    "https://docs.example.com/a.html",
    "https://docs.example.com/b.html",
  ]);
  assert.equal(got.body, "조치 효과: 정상 표시됩니다.");
});

test("라벨과 목록 사이에 빈 줄이 있어도 모은다", () => {
  const got = splitReferences(lines("참고 공식 문서:", "", "https://docs.example.com/a.html"));
  assert.deepEqual(got.references, ["https://docs.example.com/a.html"]);
  assert.equal(got.body, "");
});

test("한 줄에 주소가 여러 개면 모두 가져온다", () => {
  const got = splitReferences("참고 공식 문서: https://a.example.com 와 https://b.example.com");
  assert.deepEqual(got.references, ["https://a.example.com", "https://b.example.com"]);
});

test("글머리와 강조가 붙은 라벨도 알아본다", () => {
  const got = splitReferences("- **참고 공식 문서:** https://docs.example.com/a.html");
  assert.deepEqual(got.references, ["https://docs.example.com/a.html"]);
  assert.equal(got.body, "");
});

test("제목 꼴로 쓴 경우도 알아본다", () => {
  const got = splitReferences(lines("#### 참고 공식 문서", "https://docs.example.com/a.html"));
  assert.deepEqual(got.references, ["https://docs.example.com/a.html"]);
  assert.equal(got.body, "");
});

test("같은 주소를 두 번 인용하면 한 번만 남는다", () => {
  const got = splitReferences(lines(
    "참고 공식 문서: https://a.example.com",
    "https://a.example.com",
  ));
  assert.deepEqual(got.references, ["https://a.example.com"]);
});

// 꼬리 마침표가 링크에 붙으면 눌러도 404 가 난다.
test("주소 끝의 문장부호는 뗀다", () => {
  const got = splitReferences("참고 공식 문서: https://docs.example.com/a.html.");
  assert.deepEqual(got.references, ["https://docs.example.com/a.html"]);
});

/*
 * 가져갈 링크가 없으면 **손대지 않는다.** 라벨만 뽑아 맨 끝에 빈 섹션을 만들면
 * 읽는 사람에게는 제목만 있고 아무것도 없는 칸이 남는다.
 */
test("주소가 없는 라벨 줄은 본문에 그대로 둔다", () => {
  const got = splitReferences("참고 공식 문서: 별도 공식 문서는 없습니다.");
  assert.deepEqual(got.references, []);
  assert.equal(got.body, "참고 공식 문서: 별도 공식 문서는 없습니다.");
});

// 뒤에 다른 이야기가 이어지는데 통째로 삼키면 본문이 사라진다.
test("주소가 없는 줄에서 멈춘다", () => {
  const got = splitReferences(lines(
    "참고 공식 문서: https://a.example.com",
    "조치 효과: 정상 표시됩니다.",
  ));
  assert.deepEqual(got.references, ["https://a.example.com"]);
  assert.equal(got.body, "조치 효과: 정상 표시됩니다.");
});

/*
 * 코드 블록 안의 주소는 **설정값**이다. 참고 문서로 끌어내면 설정이 깨진다 —
 * 이 섹션은 설정 구문을 원문 그대로 옮기게 되어 있다.
 */
test("코드 블록 안의 주소는 건드리지 않는다", () => {
  const text = lines(
    "조치 방안: 다음 설정을 적용했습니다.",
    "```yaml",
    "endpoint: https://metrics.example.com/api",
    "```",
  );
  const got = splitReferences(text);
  assert.deepEqual(got.references, []);
  assert.equal(got.body, text);
});

test("참고 문서가 없으면 본문이 그대로다", () => {
  const text = "조치 방안: 쿼터를 올렸습니다.";
  assert.deepEqual(splitReferences(text), { body: text, references: [] });
});

test("떼어낸 주소는 한 줄에 하나씩 적는다", () => {
  assert.equal(renderReferences(["https://a.example.com", "https://b.example.com"]),
    lines("- https://a.example.com", "- https://b.example.com"));
});

/* ------------------------------------------------------------------ *
 * 소제목 올리기
 * ------------------------------------------------------------------ */

test("라벨을 소제목으로 올리고 본문을 아래로 내린다", () => {
  const got = promoteSubheadings(
    lines(
      "조치 방안: 메트릭 엔드포인트를 활성화하도록 안내했습니다.",
      "조치 효과: 재배포 후 사용량이 정상 표시됩니다.",
    ),
    ["조치 방안", "조치 효과"],
  );
  assert.equal(got, lines(
    "#### 조치 방안",
    "",
    "메트릭 엔드포인트를 활성화하도록 안내했습니다.",
    "",
    "#### 조치 효과",
    "",
    "재배포 후 사용량이 정상 표시됩니다.",
  ));
});

// 소제목은 `####` 다. 섹션 제목(`###`)과 같은 단계면 안에 든 것으로 읽히지 않는다.
test("소제목은 섹션 제목보다 한 단계 아래다", () => {
  const got = promoteSubheadings("조치 방안: 했습니다.", ["조치 방안"]);
  assert.ok(got.startsWith("#### "), got);
});

test("라벨 아래 여러 줄은 그대로 따라온다", () => {
  const got = promoteSubheadings(
    lines("조치 방안: 첫 줄입니다.", "- 둘째 항목", "- 셋째 항목"),
    ["조치 방안"],
  );
  assert.equal(got, lines("#### 조치 방안", "", "첫 줄입니다.", "- 둘째 항목", "- 셋째 항목"));
});

// 모델이 붙여 쓰거나 강조를 달아 보내도 문서에는 정해진 표기로 나와야 한다.
test("라벨 표기가 달라도 정해진 글자로 다시 쓴다", () => {
  for (const raw of ["조치방안: 했습니다.", "- **조치 방안:** 했습니다.", "조치 방안 : 했습니다."]) {
    assert.ok(promoteSubheadings(raw, ["조치 방안"]).startsWith("#### 조치 방안"), raw);
  }
});

test("라벨만 있고 본문이 다음 줄이면 제목만 올린다", () => {
  const got = promoteSubheadings(lines("조치 방안:", "다음 줄이 본문입니다."), ["조치 방안"]);
  assert.equal(got, lines("#### 조치 방안", "", "다음 줄이 본문입니다."));
});

test("코드 블록 안의 라벨은 올리지 않는다", () => {
  const text = lines("```", "조치 방안: echo hi", "```");
  assert.equal(promoteSubheadings(text, ["조치 방안"]), text);
});

test("올릴 라벨이 없으면 본문이 그대로다", () => {
  const text = "조치 방안: 했습니다.";
  assert.equal(promoteSubheadings(text, []), text);
});

test("다른 라벨은 글머리 항목으로 남는다", () => {
  const got = promoteSubheadings(
    lines("조치 방안: 했습니다.", "우회 조치: 임시로 돌렸습니다."),
    ["조치 방안"],
  );
  assert.ok(got.includes("우회 조치: 임시로 돌렸습니다."), got);
  assert.ok(!got.includes("#### 우회 조치"), got);
});

/* ------------------------------------------------------------------ *
 * 섹션 제목 이름
 * ------------------------------------------------------------------ */

test("떼어낸 참고 문서의 섹션 제목이 있다", () => {
  assert.equal(REFERENCE_HEADING, "참고 공식 문서");
});
