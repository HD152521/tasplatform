/**
 * Product · Component 자동 분류 규칙.
 *
 * 이게 틀리면 **엉뚱한 제품으로 SR 이 올라간다.** id 는 포털이 쓰는 실제 값이라,
 * 목록에 없는 쌍을 통과시키면 거절당하는 게 아니라 다른 제품으로 등록된다.
 * 올려 보기 전까지 아무도 모르므로 여기서 잠근다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLASSIFY_SYSTEM_PROMPT,
  buildChoiceList,
  buildClassifyUser,
  codeOf,
  mostUsed,
  parseClassified,
  resolveClassification,
  type Choice,
} from "../lib/classifyCase.ts";
import { PRODUCT_CATALOG } from "../lib/productCatalog.ts";

const CHOICES: Choice[] = [
  { productId: 4322, productName: "TAS", componentId: 9698, componentName: "TAS System Applications", used: 40 },
  { productId: 4322, productName: "TAS", componentId: 9695, componentName: "Diego", used: 12 },
  { productId: 4301, productName: "Operations Manager", componentId: 9294, componentName: "BOSH", used: 7 },
  { productId: 4332, productName: "GemFire", componentId: 9453, componentName: "GemFire", used: 0 },
];

/*
 * **같은 componentId 가 두 제품에 걸린 경우.** 지어낸 값이 아니라 실제 카탈로그의
 * 모양이다(아래 "실제 카탈로그" 시험이 그 사실을 따로 확인한다). 9453 이 Gemfire 와
 * Data Suite 양쪽에 있다.
 */
const AMBIGUOUS: Choice[] = [
  ...CHOICES,
  { productId: 4289, productName: "Data Suite", componentId: 9453, componentName: "GemFire", used: 3 },
];

// ---------------------------------------------------------------- 코드

test("코드는 제품과 컴포넌트의 쌍이다", () => {
  assert.equal(codeOf({ productId: 4322, componentId: 9695 }), "4322-9695");
});

// ---------------------------------------------------------------- 프롬프트

/*
 * 목록은 **많이 쓴 순**이어야 한다. 모델이 앞쪽을 기본값처럼 다루므로, 앞쪽이 우리가
 * 실제로 많이 올리는 조합이어야 한다. 순서가 흔들리면 분류 결과도 흔들린다.
 */
test("고를 목록은 많이 쓴 순으로 실린다", () => {
  const lines = buildChoiceList(CHOICES).split("\n");
  assert.deepEqual(lines.map((l) => l.split("\t")[0]), ["4322-9698", "4322-9695", "4301-9294", "4332-9453"]);
});

/*
 * 같은 컴포넌트 이름이 두 줄로 나올 때 **코드가 달라야** 모델이 구분할 수 있다.
 * 한때 componentId 만 실어서 두 줄이 같은 번호로 나왔고, 모델은 어느 쪽인지 말할
 * 방법이 없었다.
 */
test("같은 컴포넌트가 두 제품에 있으면 코드로 갈린다", () => {
  const codes = buildChoiceList(AMBIGUOUS).split("\n")
    .filter((l) => l.includes("GemFire"))
    .map((l) => l.split("\t")[0]);
  assert.equal(codes.length, 2);
  assert.equal(new Set(codes).size, 2, "두 줄의 코드가 달라야 한다");
});

// 건수는 싣지 않는다. 공개 저장소에서 컴포넌트별 건수는 업무 구성을 드러낸다.
test("목록에 사용 건수를 싣지 않는다", () => {
  const listed = buildChoiceList(CHOICES);
  for (const used of [40, 12, 7]) {
    assert.ok(!listed.includes(`\t${used}`) && !listed.endsWith(String(used)),
      `건수 ${used} 가 노출됐다`);
  }
});

test("프롬프트가 목록의 코드만 쓰라고 못 박는다", () => {
  assert.ok(CLASSIFY_SYSTEM_PROMPT.includes("목록의 코드 중에서만"));
  assert.ok(CLASSIFY_SYSTEM_PROMPT.includes("PICK"));
});

test("사용자 메시지에 목록과 적은 내용이 함께 들어간다", () => {
  const user = buildClassifyUser("  Diego 가 앱을 못 띄웁니다  ", CHOICES);
  assert.ok(user.includes("4322-9695\tTAS > Diego"));
  assert.ok(user.includes("Diego 가 앱을 못 띄웁니다"));
  assert.ok(!user.includes("  Diego"), "앞뒤 공백은 다듬어야");
});

// ---------------------------------------------------------------- 파싱

test("두 줄 답을 읽는다", () => {
  const got = parseClassified("PICK: 4322-9695\nREASON: Diego 가 앱 배치를 맡는다");
  assert.deepEqual(got, { productId: 4322, componentId: 9695, reason: "Diego 가 앱 배치를 맡는다" });
});

// 모델이 모양을 조금씩 흔든다. 대소문자·등호·여백·순서 바뀜을 전부 받아 준다.
test("모양이 조금 달라도 읽는다", () => {
  assert.equal(parseClassified("pick = 4301-9294\nreason = BOSH")?.componentId, 9294);
  assert.equal(parseClassified("  PICK :  4322 - 9698  ")?.componentId, 9698);
  assert.equal(parseClassified("REASON: 먼저 적은 이유\nPICK: 4322-9695")?.componentId, 9695);
});

/*
 * 코드 뒤에 군더더기가 붙어도 읽는다. 끝을 `$` 로 막아 두었더니 모델이 괄호로 설명을
 * 덧붙이는 흔한 경우에 통째로 폴백으로 떨어졌다 — 안전하긴 하지만 쓸모없이 자주.
 */
test("코드 뒤에 설명이 붙어도 읽는다", () => {
  const got = parseClassified("PICK: 4322-9695 (TAS > Diego)\nREASON: 배치 실패");
  assert.deepEqual(got, { productId: 4322, componentId: 9695, reason: "배치 실패" });
});

test("이유가 없어도 코드만 있으면 읽는다", () => {
  assert.deepEqual(parseClassified("PICK: 4322-9698"),
    { productId: 4322, componentId: 9698, reason: "" });
});

test("코드를 못 찾으면 null 이다", () => {
  for (const bad of ["", "모르겠습니다", "PICK: 없음", "PICK: 4322", "PICK: -9698",
    "PICK: 0-9698", "PICK: 4322-0", "PICK: abc-def", "4322-9698"]) {
    assert.equal(parseClassified(bad), null, `거부해야 함: ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------- 폴백·검증

test("가장 많이 쓴 조합이 폴백이다", () => {
  assert.equal(mostUsed(CHOICES)?.componentId, 9698);
  assert.equal(mostUsed([]), null);
});

/*
 * **지어낸 코드는 통과하지 않는다.** 그럴듯한 숫자가 넘어오면 폴백으로 떨어지고,
 * 폴백이라는 사실이 결과에 남아 화면에 표시된다.
 */
test("목록에 없는 코드는 버리고 폴백으로 간다", () => {
  const got = resolveClassification("PICK: 9999-12345\nREASON: 그럴듯한 이유", CHOICES);
  assert.ok(got !== null);
  assert.equal(got.choice.componentId, 9698, "폴백으로 떨어져야");
  assert.equal(got.fallback, true, "폴백이라는 사실이 남아야");
  assert.equal(got.reason, "", "쓰지 않은 답의 이유를 남기면 안 된다");
});

/*
 * **componentId 는 맞지만 productId 가 목록에 없는 조합**도 거부한다. 이게 한때
 * 통과했다 — componentId 하나로만 찾아서, 배열에서 먼저 나오는 다른 제품이 걸렸고
 * fallback 이 false 라 화면 경고도 뜨지 않았다.
 */
test("컴포넌트 번호는 맞아도 제품이 다르면 폴백이다", () => {
  const got = resolveClassification("PICK: 7777-9695\nREASON: 엉뚱한 제품", CHOICES);
  assert.ok(got !== null);
  assert.equal(got.fallback, true);
  assert.equal(got.choice.componentId, 9698);
});

/*
 * 같은 componentId 가 두 제품에 있을 때, **모델이 고른 제품이 그대로 나와야 한다.**
 * 이 시험이 이 파일의 핵심이다.
 */
test("같은 컴포넌트 번호 중 모델이 고른 제품이 선택된다", () => {
  const dataSuite = resolveClassification("PICK: 4289-9453\nREASON: Data Suite 쪽", AMBIGUOUS);
  assert.ok(dataSuite !== null);
  assert.equal(dataSuite.choice.productId, 4289);
  assert.equal(dataSuite.choice.productName, "Data Suite");
  assert.equal(dataSuite.fallback, false);

  const gemfire = resolveClassification("PICK: 4332-9453\nREASON: Gemfire 쪽", AMBIGUOUS);
  assert.ok(gemfire !== null);
  assert.equal(gemfire.choice.productId, 4332);
  assert.equal(gemfire.choice.productName, "GemFire");
  assert.equal(gemfire.fallback, false);
});

test("목록에 있는 코드는 그대로 쓰고 이유를 남긴다", () => {
  const got = resolveClassification("PICK: 4301-9294\nREASON: BOSH 디스크", CHOICES);
  assert.ok(got !== null);
  assert.equal(got.choice.componentId, 9294);
  assert.equal(got.choice.productId, 4301, "제품도 그 조합의 것이어야");
  assert.equal(got.fallback, false);
  assert.equal(got.reason, "BOSH 디스크");
});

// LLM 이 없을 때(연결 미설정·호출 실패)도 올릴 수 있어야 한다.
test("모델 답이 없으면 폴백이다", () => {
  const got = resolveClassification(null, CHOICES);
  assert.ok(got !== null);
  assert.equal(got.choice.componentId, 9698);
  assert.equal(got.fallback, true);
});

test("읽을 수 없는 답도 폴백이다", () => {
  const got = resolveClassification("무슨 말인지 모르겠습니다", CHOICES);
  assert.ok(got !== null);
  assert.equal(got.fallback, true);
});

/*
 * 목록이 비면 **null** 이다. 그때는 올릴 수 없다 — 아무 번호나 지어 넣는 것보다
 * 올리지 못하는 편이 낫다. 라우트가 이걸 받아 사람에게 안내한다.
 */
test("고를 것이 하나도 없으면 null 이다", () => {
  assert.equal(resolveClassification("PICK: 4322-9698", []), null);
  assert.equal(resolveClassification(null, []), null);
});

// 고른 것은 **반드시 목록에 있던 객체**여야 한다. 새로 만든 값이 섞이면 안 된다.
test("고른 것은 받은 목록의 항목이다", () => {
  for (const answer of ["PICK: 4301-9294", "PICK: 9999-9999", null]) {
    const got = resolveClassification(answer, CHOICES);
    assert.ok(got !== null);
    assert.ok(CHOICES.includes(got.choice), `목록 밖의 값이 나왔다: ${answer}`);
  }
});

// ---------------------------------------------------------------- 실제 카탈로그

/*
 * **이 시험이 위 AMBIGUOUS 픽스처의 근거다.** 실제 카탈로그에 같은 componentId 가
 * 두 제품에 걸린 경우가 있다. 0 이 되는 날 이 시험이 깨지는데, 그때는 쌍으로 다루는
 * 수고를 덜어도 되는지 다시 판단하라는 뜻이다 — 지금은 반드시 쌍이어야 한다.
 */
test("실제 카탈로그에 componentId 가 겹치는 제품이 있다", () => {
  const products = new Map<number, Set<number>>();
  for (const entry of PRODUCT_CATALOG) {
    const seen = products.get(entry.componentId) ?? new Set<number>();
    seen.add(entry.productId);
    products.set(entry.componentId, seen);
  }
  const shared = [...products].filter(([, p]) => p.size > 1);
  assert.ok(shared.length > 0,
    "겹치는 componentId 가 없어졌다면 codeOf 주석의 근거를 다시 보라");
});

/** 코드는 카탈로그 안에서 유일해야 한다. 아니면 쌍으로도 구분이 안 된다. */
test("실제 카탈로그의 코드는 유일하다", () => {
  const codes = PRODUCT_CATALOG.map(codeOf);
  assert.equal(new Set(codes).size, codes.length, "같은 코드가 두 번 있다");
});

// ---------------------------------------------------------------- 깨진 데이터

/*
 * **깨진 줄이 섞여도 죽지 않는다.**
 *
 * 실제로 운영에서 터졌다 — SQL 별칭에 따옴표가 없어 Postgres 가 컬럼명을 소문자로
 * 접었고, 모든 필드가 undefined 인 줄이 목록에 섞여 `localeCompare` 에서 예외가 났다.
 * 데이터 문제가 HTTP 500 으로 나가면 사람은 원인을 짐작할 수도 없다.
 */
const BROKEN = [
  // Postgres 가 컬럼명을 접었을 때의 모양 — 이름도 id 도 없다.
  { productId: undefined, productName: undefined, componentId: undefined,
    componentName: undefined, used: 3 },
  { productId: 0, productName: "", componentId: 0, componentName: "", used: 1 },
] as unknown as Choice[];

test("깨진 줄이 섞여도 목록을 만든다", () => {
  const listed = buildChoiceList([...BROKEN, ...CHOICES]);
  const codes = listed.split("\n").map((l) => l.split("\t")[0]);
  assert.deepEqual(codes, ["4322-9698", "4322-9695", "4301-9294", "4332-9453"],
    "깨진 줄은 빠지고 멀쩡한 줄만 남아야");
});

test("깨진 줄이 섞여도 분류가 된다", () => {
  const got = resolveClassification("PICK: 4301-9294\nREASON: BOSH", [...BROKEN, ...CHOICES]);
  assert.ok(got !== null);
  assert.equal(got.choice.componentId, 9294);
  assert.equal(got.fallback, false);
});

test("깨진 줄은 폴백으로도 고르지 않는다", () => {
  const got = resolveClassification(null, [...BROKEN, ...CHOICES]);
  assert.ok(got !== null);
  assert.equal(got.choice.componentId, 9698, "멀쩡한 것 중 가장 많이 쓴 것");
});

// 전부 깨졌으면 올릴 수 없다 — id 없이 등록을 시도하지 않는다.
test("쓸 수 있는 줄이 하나도 없으면 null 이다", () => {
  assert.equal(resolveClassification("PICK: 4322-9698", BROKEN), null);
  assert.equal(mostUsed(BROKEN), null);
});
