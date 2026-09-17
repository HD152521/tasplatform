/**
 * Confluence 문서 섹션 분할.
 *
 * 사내 엔드포인트의 출력 상한이 512 토큰이라 문서를 한 번에 받을 수 없다.
 * 섹션마다 따로 받고 조립은 코드가 한다 — 여기서 검증하는 것은 그 조립과 예산이다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONFLUENCE_SECTIONS,
  SECTION_TIMEOUT_MS,
  assembleConfluenceDoc,
  cleanSectionText,
  sectionSystemPrompt,
} from "../lib/summaryPrompt.ts";

const NEWLINE = String.fromCharCode(10);
const lines = (...parts: string[]): string => parts.join(NEWLINE);

const byId = (id: string) => {
  const found = CONFLUENCE_SECTIONS.find((s) => s.id === id);
  assert.ok(found, `섹션이 없다: ${id}`);
  return found;
};

/**
 * 섹션 호출은 max_tokens 를 넘기지 않아 운영 설정(config.maxTokens)을 따른다.
 * 대신 왕복 횟수가 라우트 예산 안에 들어와야 한다 — head 와 문제 정의를 함께 보내므로
 * 왕복은 네 번이고, 라우트의 maxDuration 은 300 초다.
 */
test("최악의 경우에도 라우트 예산 안에서 끝난다", () => {
  const roundTrips = 4;
  assert.ok(SECTION_TIMEOUT_MS * roundTrips <= 300_000, String(SECTION_TIMEOUT_MS));
});

test("출력 골격의 섹션이 순서대로 정의되어 있다", () => {
  assert.deepEqual(
    CONFLUENCE_SECTIONS.map((s) => s.id),
    ["head", "problem", "cause", "solution", "result"],
  );
  // 제목과 환경 표는 골격에서 제목 줄을 갖지 않는다.
  assert.equal(byId("head").heading, "");
  assert.equal(byId("cause").heading, "원인 및 기술 배경");
});

test("섹션 프롬프트는 기존 본문 프롬프트와 사실 규칙, 이번 지시를 함께 준다", () => {
  const prompt = sectionSystemPrompt(byId("cause"));
  assert.ok(prompt.includes("# 출력 골격"), "기존 프롬프트 본문이 그대로 있어야 한다");
  assert.ok(prompt.includes("원인으로 쓰지 않습니다"), "배제된 가설 규칙");
  assert.ok(prompt.includes("~로 추정됩니다"), "추정 표기 규칙");
  assert.ok(prompt.includes("# 이번 호출"), "이번 섹션 지시");
  assert.ok(prompt.includes("섹션 제목 줄은 출력하지 않습니다"));
});

// 모델이 지시를 어기고 섹션 제목을 되쓰는 일이 있다. 조립할 때 제목이 겹치면 안 된다.
test("모델이 섹션 제목을 되써도 걷어낸다", () => {
  const got = cleanSectionText(lines("원인 및 기술 배경", "", "체크섬 오프로딩이 켜져 있었습니다."));
  assert.equal(got, "체크섬 오프로딩이 켜져 있었습니다.");
});

test("마크다운 제목 표기로 되써도 걷어낸다", () => {
  assert.equal(cleanSectionText(lines("## 해결 방법", "본문입니다.")), "본문입니다.");
});

// 해결 방법 섹션은 설정 구문을 코드 블록으로 그대로 옮기게 되어 있다. 그건 남아야 한다.
test("본문 안의 코드 블록은 지우지 않는다", () => {
  const text = lines("규칙을 아래와 같이 구성했습니다.", "", "```", "if $programname == 'x' then stop", "```");
  const got = cleanSectionText(text);
  assert.ok(got.includes("if $programname == 'x' then stop"), got);
  assert.ok(got.includes("```"), got);
});

test("조립하면 골격 순서대로 제목과 본문이 붙는다", () => {
  const doc = assembleConfluenceDoc([
    { section: byId("head"), text: lines("[99990001] 로그 선별 전송 구성", "", "| 항목 | 내용 |", "|---|---|", "| 제품 | Sample Platform |") },
    { section: byId("problem"), text: "전체 로그가 전달되는 제약이 있었습니다." },
    { section: byId("cause"), text: "전송 단위가 디렉터리 전체로 정의되어 있습니다." },
    { section: byId("solution"), text: "수신 서버 측에 규칙을 구성했습니다." },
    { section: byId("result"), text: "구성을 확인하여 전달 완료했습니다." },
  ]);

  assert.ok(doc.startsWith("[99990001] 로그 선별 전송 구성"), doc);
  assert.ok(doc.includes("| 항목 | 내용 |"));
  for (const heading of ["문제 정의", "원인 및 기술 배경", "해결 방법", "최종 결과"]) {
    assert.ok(doc.includes(`${heading}\n\n`), `${heading} 제목이 없다`);
  }
  // 골격 순서가 지켜져야 한다.
  assert.ok(doc.indexOf("문제 정의") < doc.indexOf("원인 및 기술 배경"));
  assert.ok(doc.indexOf("해결 방법") < doc.indexOf("최종 결과"));
});

// 한 섹션이 빈 채로 와도 제목만 덩그러니 남기지 않는다.
test("빈 섹션은 제목째로 뺀다", () => {
  const doc = assembleConfluenceDoc([
    { section: byId("problem"), text: "내용 있음" },
    { section: byId("cause"), text: "   " },
  ]);
  assert.ok(doc.includes("문제 정의"));
  assert.ok(!doc.includes("원인 및 기술 배경"), doc);
});
