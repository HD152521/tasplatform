/**
 * Confluence 문서 섹션 분할과 양식 조립.
 *
 * 골격은 팀 양식(Confluence "SR 현행화 양식", id 172261444)이 정한다 —
 * 제목 한 줄 → 4행 고정 표 → 문제 / 환경 및 진단 내역 / 원인 분석 / 해결 제안 및 조치 방안.
 * 사내 엔드포인트의 출력 상한 때문에 섹션마다 따로 받고 조립은 코드가 한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONFLUENCE_SECTIONS,
  SECTION_TIMEOUT_MS,
  assembleConfluenceDoc,
  buildDocTitle,
  buildMetaTable,
  cleanSectionText,
  firstLine,
  formatSrDate,
  parseMeta,
  sectionSystemPrompt,
} from "../lib/summaryPrompt.ts";

const NEWLINE = String.fromCharCode(10);
const lines = (...parts: string[]): string => parts.join(NEWLINE);

const byId = (id: string) => {
  const found = CONFLUENCE_SECTIONS.find((s) => s.id === id);
  assert.ok(found, `섹션이 없다: ${id}`);
  return found;
};

/* ------------------------------------------------------------------ *
 * 골격
 * ------------------------------------------------------------------ */

test("출력 골격의 섹션이 양식 순서대로 정의되어 있다", () => {
  assert.deepEqual(
    CONFLUENCE_SECTIONS.map((s) => s.id),
    ["title", "meta", "problem", "diagnosis", "cause", "solution"],
  );
  // 제목과 표값은 문서에 제목 줄을 갖지 않는다(코드가 따로 조립한다).
  assert.equal(byId("title").heading, "");
  assert.equal(byId("meta").heading, "");
  assert.equal(byId("diagnosis").heading, "환경 및 진단 내역");
  assert.equal(byId("solution").heading, "해결 제안 및 조치 방안");
});

/** 왕복은 네 번(제목·표값·문제 병렬 + 진단 + 원인 + 조치)이고 라우트 예산은 300초다. */
test("최악의 경우에도 라우트 예산 안에서 끝난다", () => {
  assert.ok(SECTION_TIMEOUT_MS * 4 <= 300_000, String(SECTION_TIMEOUT_MS));
});

test("섹션 프롬프트는 기존 본문 프롬프트와 사실 규칙, 이번 지시를 함께 준다", () => {
  const prompt = sectionSystemPrompt(byId("cause"));
  assert.ok(prompt.includes("# 출력 골격"), "기존 프롬프트 본문이 그대로 있어야 한다");
  assert.ok(prompt.includes("관측·확인된 사실"), "원인은 이 환경에서 확인된 것만");
  assert.ok(prompt.includes("참고로만 언급했다면 원인이 아닙니다"), "배제된 가설 규칙");
  assert.ok(prompt.includes("# 이번 호출"), "이번 섹션 지시");
});

/* ------------------------------------------------------------------ *
 * 표 4행 — 양식이 정한 고정 형식
 * ------------------------------------------------------------------ */

test("날짜는 포털 표기를 YYYY-MM-DD 로 편다", () => {
  assert.equal(formatSrDate("02-August-2026 20:06:11"), "2026-08-02");
  assert.equal(formatSrDate("08-September-2026 01:32:06"), "2026-09-08");
  assert.equal(formatSrDate("말이 안 되는 값"), "");
  assert.equal(formatSrDate(null), "");
});

test("meta 섹션에서 유형을 뽑는다", () => {
  assert.equal(parseMeta(lines("유형: 장애 대응", "대상 환경: [은/중]개발,운영")).type, "장애 대응");
});

// 실측에서 "한 줄만" 이라고 했는데도 문서를 통째로 써 보냈다. 형식 준수에 기대지 않는다.
test("모델이 형식을 어기고 길게 써도 유형을 찾아낸다", () => {
  const essay = lines(
    "[37027473] 통신 지연 분석",
    "| 항목 | 내용 |",
    "| 유형 | 장애 대응 |",
    "이 건은 서비스 중단을 동반했습니다.",
  );
  assert.equal(parseMeta(essay).type, "장애 대응");
});

test("모델이 글머리 기호나 강조를 붙여도 값만 뽑는다", () => {
  const got = parseMeta(lines("- **유형**: 문의", "* 대상 환경 : `[은] 운영`"));
  assert.equal(got.type, "문의");
});

// 못 찾으면 빈 값이다. 지어내면 표에 틀린 값이 박힌다.
test("meta 를 못 읽으면 빈 값을 돌려준다", () => {
  assert.deepEqual(parseMeta("모르겠습니다"), { type: "" });
});

test("표는 양식대로 정확히 4행이다", () => {
  const table = buildMetaTable({
    openedRaw: "08-September-2026 01:32:06",
    closedRaw: "16-September-2026 20:29:59",
    priority: "Medium - P3",
    status: "Closed", meta: { type: "문의" }, target: "[은] 운영",
  });
  assert.equal(table.split(NEWLINE).length, 6, table); // 머리 2줄 + 4행
  assert.ok(table.includes("| SR 오픈/종료 일시 | 2026-09-08 ~ 2026-09-16 |"), table);
  assert.ok(table.includes("| 유형 | 문의 |"), table);
  assert.ok(table.includes("| 대상 환경 | [은] 운영 |"), table);
  assert.ok(table.includes("| 심각도 | P3 |"), table);
});

test("심각도는 포털 표기에서 P 번호만 뽑는다", () => {
  const of = (priority: string): string =>
    buildMetaTable({ openedRaw: "", closedRaw: "", priority, status: "Closed", meta: { type: "" } });
  assert.ok(of("High - P2").includes("| 심각도 | P2 |"));
  assert.ok(of("Medium - P3").includes("| 심각도 | P3 |"));
});

test("하루 만에 끝난 건도 범위로 적는다", () => {
  const table = buildMetaTable({
    openedRaw: "11-August-2026 09:00:00",
    closedRaw: "11-August-2026 18:46:05",
    priority: "Medium - P3",
    status: "Closed", meta: { type: "문의" }, target: "[은/중]개발,운영",
  });
  assert.ok(table.includes("| SR 오픈/종료 일시 | 2026-08-11 ~ 2026-08-11 |"), table);
});

// 마지막 갱신일은 종료일이 아니다. 안 닫힌 케이스에 종료일을 적으면 거짓이 된다.
test("종료되지 않은 케이스는 종료일을 적지 않는다", () => {
  const table = buildMetaTable({
    openedRaw: "08-September-2026 01:32:06",
    closedRaw: "16-September-2026 20:29:59",
    status: "Pending Support",
    priority: "Medium - P3",
    meta: { type: "문의" },
  });
  assert.ok(table.includes("| SR 오픈/종료 일시 | 2026-09-08 ~ (진행 중) |"), table);
});

// 본문으로는 은행인지 중앙회인지 못 가린다. 틀린 값을 조용히 싣느니 빈칸을 드러낸다.
test("대상 환경을 안 주면 사람이 채울 자리를 남긴다", () => {
  const table = buildMetaTable({
    openedRaw: "11-August-2026 09:00:00",
    closedRaw: "11-August-2026 18:46:05",
    status: "Closed",
    priority: "Medium - P3",
    meta: { type: "문의" },
  });
  assert.ok(table.includes("| 대상 환경 | (입력 필요) |"), table);
});

test("제목은 SR 번호와 종료 표시를 코드가 붙인다", () => {
  assert.equal(
    buildDocTitle("37027473", "C2C 통신 지연 현상 분석", "Closed"),
    "[SR 37027473] C2C 통신 지연 현상 분석 (완료)",
  );
  // 진행 중이면 (완료) 를 붙이지 않는다.
  assert.equal(
    buildDocTitle("37081078", "디스크 사용률 문의", "Pending Support"),
    "[SR 37081078] 디스크 사용률 문의",
  );
  // 모델이 대괄호나 (완료) 를 붙여 와도 중복되지 않는다.
  assert.equal(
    buildDocTitle("1", "[SR 1] 제목 (완료)", "Closed"),
    "[SR 1] 제목 (완료)",
  );
});

/* ------------------------------------------------------------------ *
 * 본문 정리
 * ------------------------------------------------------------------ */

test("모델이 섹션 제목을 되써도 걷어낸다", () => {
  assert.equal(cleanSectionText(lines("원인 분석", "", "체크섬 오프로딩이 켜져 있었습니다.")), "체크섬 오프로딩이 켜져 있었습니다.");
  assert.equal(cleanSectionText(lines("### 해결 제안 및 조치 방안", "본문입니다.")), "본문입니다.");
});

// 표는 코드가 만든다. 본문 섹션의 표는 양식의 4행 표 밑에 또 붙어 버린다.
test("본문 섹션이 만든 표와 머리 제목은 걷어낸다", () => {
  const got = cleanSectionText(
    lines("[99990001] 지연 현상 분석 요청", "| 항목 | 내용 |", "|---|---|", "| 제품 | Sample |", "", "실제 본문입니다."),
  );
  assert.equal(got, "실제 본문입니다.");
});

// 진단·조치 섹션은 명령과 설정 구문을 그대로 옮기게 되어 있다.
test("코드 블록은 파이프가 들어 있어도 지우지 않는다", () => {
  const text = lines("아래와 같이 확인합니다.", "", "```", "cat x | grep -v stderr", "```");
  const got = cleanSectionText(text);
  assert.ok(got.includes("cat x | grep -v stderr"), got);
  assert.ok(got.includes("```"), got);
});

test("firstLine 은 기호·따옴표·코드펜스를 걷어내고 한 줄만 준다", () => {
  assert.equal(firstLine('- • "[SR 1] 통신 지연 분석"'), "[SR 1] 통신 지연 분석");
  assert.equal(firstLine(lines("```", "# [SR 1] 제목", "덧붙인 설명")), "[SR 1] 제목");
});

/* ------------------------------------------------------------------ *
 * 조립
 * ------------------------------------------------------------------ */

test("조립하면 제목 → 표 → 네 섹션 순서로 붙는다", () => {
  const table = buildMetaTable({
    openedRaw: "11-August-2026 09:00:00",
    closedRaw: "11-August-2026 18:46:05",
    priority: "Medium - P3",
    status: "Closed", meta: { type: "문의" }, target: "[은/중]개발,운영",
  });
  const doc = assembleConfluenceDoc({
    title: "[SR 99990001] 인증서 만료 경고 관련 문의",
    table,
    sections: [
      { section: byId("problem"), text: "발생 현상: 경고가 표시됩니다." },
      { section: byId("diagnosis"), text: "운영 환경: Sample Platform v3.1.2" },
      { section: byId("cause"), text: "비활성 인증서: 남아 있었습니다." },
      { section: byId("solution"), text: "조치 방안: 삭제 절차를 실행했습니다." },
    ],
  });

  assert.ok(doc.startsWith("[SR 99990001] 인증서 만료 경고 관련 문의"), doc);
  assert.ok(doc.indexOf("| 심각도 | P3 |") < doc.indexOf("### 문제"), "표가 본문보다 앞");
  for (const heading of ["문제", "환경 및 진단 내역", "원인 분석", "해결 제안 및 조치 방안"]) {
    assert.ok(doc.includes(`### ${heading}\n\n`), `${heading} 제목이 없다`);
  }
  assert.ok(doc.indexOf("### 문제") < doc.indexOf("### 환경 및 진단 내역"));
  assert.ok(doc.indexOf("### 원인 분석") < doc.indexOf("### 해결 제안 및 조치 방안"));
});

// 제목과 표값 섹션은 코드가 따로 다룬다. 본문에 두 번 나오면 안 된다.
test("제목·표값 섹션은 본문으로 붙지 않는다", () => {
  const doc = assembleConfluenceDoc({
    title: "[SR 1] 제목",
    table: "| 항목 | 내용 |",
    sections: [
      { section: byId("title"), text: "[SR 1] 제목" },
      { section: byId("meta"), text: "유형: 문의" },
      { section: byId("problem"), text: "발생 현상: 있음" },
    ],
  });
  assert.equal(doc.split("[SR 1] 제목").length - 1, 1, doc);
  assert.ok(!doc.includes("유형: 문의"), doc);
});

test("빈 섹션은 제목째로 뺀다", () => {
  const doc = assembleConfluenceDoc({
    title: "",
    table: "",
    sections: [
      { section: byId("problem"), text: "내용 있음" },
      { section: byId("cause"), text: "   " },
    ],
  });
  assert.ok(doc.includes("### 문제"));
  assert.ok(!doc.includes("### 원인 분석"), doc);
});
