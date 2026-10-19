/**
 * Jira 티켓 제목·본문 규칙.
 *
 * 모양이 틀리면 티켓 수십 개를 손으로 고쳐야 한다. 그래서 여기서 잠근다.
 * 실제 케이스 번호·담당자명·고객 문장은 쓰지 않는다 — 이 저장소는 공개다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TRACK, guessTrack, hasHangul, koTitleFrom, readTrack, srTicketBody,
  srTicketSummary, type SrTicketInput,
} from "../lib/jiraSrTicket.ts";

const BASE: SrTicketInput = {
  caseLabel: "20000001",      // 자리표시자
  titleKo: "노드 재시작 원인 문의",
  subjectEn: "Inquiry about node restart",
  track: "운영",
  productName: "제품",
  componentName: "컴포넌트",
  bodyKo: "노드가 간헐적으로 재시작됩니다.\n로그에 타임아웃이 보입니다.",
  caseUrl: "https://portal.test/case/20000001",
};

test("제목은 [구분] 한글제목 진행 꼴이다", () => {
  assert.equal(srTicketSummary(BASE), "[운영] 노드 재시작 원인 문의 진행");
  assert.equal(
    srTicketSummary({ ...BASE, track: "개발" }),
    "[개발] 노드 재시작 원인 문의 진행",
  );
});

/*
 * 티켓은 **우리 팀이 읽는다.** 포털 제목은 영문이지만 목록에서 읽혀야 하므로 한글을
 * 쓴다. 한글이 없으면(영문으로 바로 쓴 경우) 영문으로 떨어진다 — 제목이 비는 것보다 낫다.
 */
test("한글이 없으면 영문으로 떨어진다", () => {
  assert.equal(
    srTicketSummary({ ...BASE, titleKo: "   " }),
    "[운영] Inquiry about node restart 진행",
  );
});

test("둘 다 없으면 케이스 번호라도 남긴다", () => {
  assert.equal(srTicketSummary({ ...BASE, titleKo: "", subjectEn: "" }), "[운영] Case 20000001");
});

// Jira 는 제목 255자를 넘기면 거부한다.
test("아주 긴 제목도 거부당하지 않게 자른다", () => {
  const long = srTicketSummary({ ...BASE, titleKo: "가".repeat(500) });
  assert.ok(long.length <= 240, `${long.length}자`);
  assert.ok(long.startsWith("[운영] "));
});

test("아는 구분만 받는다", () => {
  assert.equal(readTrack("개발"), "개발");
  assert.equal(readTrack("운영"), "운영");
  for (const bad of ["", "dev", "기타", null, undefined, 7]) {
    assert.equal(readTrack(bad), DEFAULT_TRACK, `${JSON.stringify(bad)}`);
  }
});

/*
 * 글만 보고 맞히려 들지 않는다. 환경을 가리키는 분명한 말이 있을 때만 개발로 기운다.
 */
test("환경을 가리키는 말이 있으면 개발로 기운다", () => {
  for (const text of ["개발계에서 재현됩니다", "dev 환경", "스테이징에서만", "검증계 확인"]) {
    assert.equal(guessTrack(text), "개발", text);
  }
});

/*
 * "개발자" 는 사람을 가리킨다. 이 글자 때문에 운영 건이 개발로 가면 안 된다.
 */
test("모르면 운영이고, 사람을 가리키는 말에는 기울지 않는다", () => {
  for (const text of ["개발자가 문의했습니다", "로그인이 안 됩니다", "", "운영 중 장애"]) {
    assert.equal(guessTrack(text), "운영", text);
  }
});

test("본문은 Case 를 제목처럼 올리고 원문과 링크를 담는다", () => {
  const doc = srTicketBody(BASE);
  const flat = JSON.stringify(doc);
  assert.equal(doc.content[0]?.type, "heading");
  assert.equal(doc.content[0]?.content?.[0]?.text, "Case 20000001");
  assert.match(flat, /노드가 간헐적으로 재시작됩니다/);
  assert.match(flat, /제품 \/ 컴포넌트/);
  assert.match(flat, /portal\.test\/case\/20000001/);
});

// 링크나 제품이 없어도 문서가 깨지지 않아야 한다(ADF 가 빈 노드를 거부한다).
test("빈 값이 있어도 문서가 성립한다", () => {
  const doc = srTicketBody({
    ...BASE, bodyKo: "", caseUrl: "", productName: "", componentName: "",
  });
  assert.equal(doc.type, "doc");
  const walk = (n: { text?: string; content?: unknown[] }): void => {
    if (n.text !== undefined) assert.notEqual(n.text, "", "빈 글자 노드가 있다");
    for (const c of (n.content ?? []) as Array<typeof n>) walk(c);
  };
  walk(doc as unknown as { content?: unknown[] });
});

// 원문이 길어도 티켓 본문은 추적용이다. 통째로 넣지 않는다.
test("원문이 길면 앞머리만 넣는다", () => {
  const doc = srTicketBody({ ...BASE, bodyKo: "가".repeat(5000) });
  assert.ok(JSON.stringify(doc).length < 2000, "본문이 너무 길다");
});

/*
 * ## 한글 제목 뽑기
 *
 * 사람에게 제목을 따로 적게 하지 않으려는 것이다. 뽑은 값을 입력칸에 채워 보여 주므로,
 * 완벽하지 않아도 된다 — 다만 **엉뚱하거나 비면 안 된다.**
 */
test("첫 줄을 제목으로 쓴다", () => {
  assert.equal(koTitleFrom("노드가 재시작됩니다\n로그를 첨부합니다"), "노드가 재시작됩니다");
});

test("글머리 기호와 제목 기호는 떼어낸다", () => {
  assert.equal(koTitleFrom("- 노드 재시작 문의"), "노드 재시작 문의");
  assert.equal(koTitleFrom("### 노드 재시작 문의"), "노드 재시작 문의");
  assert.equal(koTitleFrom("• - 노드 재시작 문의"), "노드 재시작 문의");
});

test("빈 줄을 건너뛰고 첫 알맹이를 찾는다", () => {
  assert.equal(koTitleFrom("\n\n   \n문제가 있습니다"), "문제가 있습니다");
});

test("글이 없으면 빈 제목이다", () => {
  assert.equal(koTitleFrom(""), "");
  assert.equal(koTitleFrom("\n \n"), "");
});

// 긴 첫 줄은 문장 끝에서 자르고, 끝 마침표는 제목에 남기지 않는다.
test("긴 줄은 문장 끝에서 자른다", () => {
  assert.equal(
    koTitleFrom("노드가 간헐적으로 재시작됩니다. 로그에 타임아웃이 보이고 재현 조건을 찾는 중입니다."),
    "노드가 간헐적으로 재시작됩니다",
  );
});

test("문장 부호가 없으면 길이로 자른다", () => {
  const title = koTitleFrom("가".repeat(200));
  assert.ok(title.length <= 60, `${title.length}자`);
  assert.ok(title.length > 0);
});

/*
 * ## 번역을 두 번 눌러도 한글이 지켜져야 한다
 *
 * 번역 버튼은 한국어를 영문으로 갈아끼운다. 두 번째로 누를 때는 입력칸에 **영문**이
 * 들어 있는데, 그걸 "한글 원문" 으로 붙잡으면 티켓 본문이 영문으로 떨어진다 — 티켓을
 * 한글로 쓰려는 이유가 사라진다. 화면이 이 판정으로 막는다.
 */
test("한글이 들어 있는지 가린다", () => {
  assert.equal(hasHangul("노드가 죽습니다"), true);
  assert.equal(hasHangul("TPCF 10.4 에서 재현"), true, "영문이 섞여도 한글이 있으면 참");
  assert.equal(hasHangul("Node keeps restarting"), false);
  assert.equal(hasHangul(""), false);
  assert.equal(hasHangul("10.4.2"), false);
});

/*
 * 이모지는 두 칸을 차지한다. 자르는 경계가 그 사이에 걸리면 외톨이 서러게이트가 JSON
 * 으로 나가고 Jira 가 400 으로 거절한다 — 곁가지 칸을 떼고 다시 보내도 같은 400 이라
 * 티켓이 아예 안 만들어진다.
 */
test("자를 때 이모지를 쪼개지 않는다", () => {
  // 제목 한도(240) 경계에 이모지가 걸리게 만든다.
  const title = "가".repeat(233) + "🚨🚨";
  const summary = srTicketSummary({ ...BASE, titleKo: title });
  for (let i = 0; i < summary.length; i += 1) {
    const code = summary.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = summary.charCodeAt(i + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, `${i}번째 글자가 짝을 잃었다`);
    }
  }
  // 본문도 같은 규칙이어야 한다.
  const doc = srTicketBody({ ...BASE, bodyKo: "나".repeat(699) + "🚨🚨" });
  const flat = JSON.stringify(doc);
  assert.ok(!/\ud800-\udbff(?![\udc00-\udfff])/.test(flat));
  assert.ok(JSON.parse(flat) !== null, "JSON 으로 왕복된다");
});
