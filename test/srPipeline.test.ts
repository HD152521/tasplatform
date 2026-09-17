import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CALL_MAX_TOKENS,
  type ChatOptions,
  assembleReport,
  batchThreads,
  cleanSection,
  firstLine,
  mergeExtractions,
  parseFactJson,
  renderFacts,
} from "../lib/srPipeline.ts";
import { type CaseMeta, composeSrReport, extractFacts } from "../lib/srCompose.ts";
import { isComplete, parseSrReport } from "../lib/srReportFormat.ts";

const NEWLINE = String.fromCharCode(10);
const lines = (...parts: string[]): string => parts.join(NEWLINE);

/** 합성 데이터다. 실제 케이스 번호·담당자명·고객 문장을 넣지 않는다. */
const META: CaseMeta = {
  requestId: "99990001",
  subject: "Sample latency investigation",
  status: "Closed",
  priority: "2",
  product: "Sample Platform",
  createdOn: "01-January-2026",
  closedOn: "05-January-2026",
  description: "Latency observed after upgrade.",
};

const THREADS = Array.from({ length: 9 }, (_, i) => ({
  isOurs: i % 3 === 0,
  at: `0${i + 1}-January-2026`,
  body: `Message number ${i + 1} about the overlay interface.`,
}));

/* ------------------------------------------------------------------ *
 * 순수 함수
 * ------------------------------------------------------------------ */

test("스레드를 지정한 크기로 묶는다", () => {
  const batches = batchThreads([1, 2, 3, 4, 5, 6, 7], 3);
  assert.deepEqual(batches, [[1, 2, 3], [4, 5, 6], [7]]);
});

test("묶음 크기가 0 이하면 거부한다", () => {
  assert.throws(() => batchThreads([1, 2], 0));
});

// 모델이 코드펜스나 인사말을 붙이는 일이 있다.
test("코드펜스와 군더더기가 붙어도 JSON 을 읽는다", () => {
  const raw = lines(
    "물론입니다. 아래와 같습니다.",
    "```json",
    '{"facts":[{"actor":"CUSTOMER","at":"01-January-2026","text":"지연 발생","metrics":"1초"}],',
    ' "environment":["Sample Platform 1.2.3"],"ruled_out":[]}',
    "```",
  );
  const got = parseFactJson(raw);
  assert.equal(got.facts.length, 1);
  assert.equal(got.facts[0]?.actor, "CUSTOMER");
  assert.equal(got.facts[0]?.metrics, "1초");
  assert.deepEqual(got.environment, ["Sample Platform 1.2.3"]);
});

// 한 묶음이 깨졌다고 나머지를 버리면 안 된다.
test("깨진 JSON 은 빈 결과로 돌려준다", () => {
  assert.deepEqual(parseFactJson("응답이 잘렸습니다 {\"facts\": ["), { facts: [], environment: [], ruledOut: [] });
  assert.deepEqual(parseFactJson(""), { facts: [], environment: [], ruledOut: [] });
});

test("actor 를 한국어로 써도 고객으로 읽는다", () => {
  const got = parseFactJson('{"facts":[{"actor":"고객사","text":"로그 제출"}]}');
  assert.equal(got.facts[0]?.actor, "CUSTOMER");
});

test("text 가 빈 사실은 버린다", () => {
  const got = parseFactJson('{"facts":[{"actor":"TAC","text":"  "},{"actor":"TAC","text":"확인함"}]}');
  assert.equal(got.facts.length, 1);
});

test("여러 묶음의 결과를 합치면서 같은 사실을 한 번만 남긴다", () => {
  const merged = mergeExtractions([
    { facts: [{ actor: "TAC", at: "", text: "체크섬 설정 확인", metrics: "" }], environment: ["env A"], ruledOut: [] },
    {
      facts: [{ actor: "TAC", at: "", text: "체크섬  설정 확인", metrics: "" }],
      environment: ["env A"],
      ruledOut: [{ hypothesis: "알려진 이슈", why: "이미 우회 적용됨" }],
    },
  ]);
  assert.equal(merged.facts.length, 1);
  assert.equal(merged.environment.length, 1);
  assert.equal(merged.ruledOut.length, 1);
});

// 배제된 가설이 원인으로 격상되는 것이 이번 오판의 정체였다.
test("배제된 가설은 쓰지 말라는 경고와 함께 넘긴다", () => {
  const text = renderFacts({
    facts: [{ actor: "TAC", at: "01-January-2026", text: "체크섬 오프로딩 해제 권고", metrics: "" }],
    environment: ["Sample Platform 1.2.3"],
    ruledOut: [{ hypothesis: "알려진 오버레이 이슈", why: "이미 우회 적용 확인" }],
  });
  assert.ok(text.includes("원인으로 쓰지 말 것"), text);
  assert.ok(text.includes("알려진 오버레이 이슈"), text);
  assert.ok(text.includes("[TAC 01-January-2026]"), text);
});

test("첫 줄만 쓰는 절은 기호와 따옴표를 걷어낸다", () => {
  assert.equal(firstLine('- • "통신 지연 분석 요청"'), "통신 지연 분석 요청");
  assert.equal(firstLine(lines("", "  ", "두 번째 줄이 첫 내용")), "두 번째 줄이 첫 내용");
});

test("절 본문에서 절 제목 반복과 코드펜스를 걷어낸다", () => {
  const got = cleanSection(lines("```", "- 진행 상황", "현상 파악: 지연 확인", "```"));
  assert.equal(got, "현상 파악: 지연 확인");
});

/* ------------------------------------------------------------------ *
 * 조립 — 양식이 깨질 수 없어야 한다
 * ------------------------------------------------------------------ */

// 지금까지는 모델이 내용과 양식을 동시에 맞춰야 했고, 어긋나면 슬라이드 칸이 비었다.
test("조립한 보고서는 기존 파서가 세 칸 모두 읽어 낸다", () => {
  const raw = assembleReport({
    title: "통신 지연 분석 및 근본 원인 조사 요청",
    inquiry: lines("업그레이드 이후 지연 발생 확인", "", "병목 식별 지표 안내 요청"),
    progress: lines("현상 파악: 지연 확인함", "후속 조치 방향: 영구 수정 반영 예정"),
    result: "우회 조치를 확인하여 고객사에 전달 완료",
  });
  const report = parseSrReport(raw);
  assert.ok(isComplete(report), raw);
  assert.equal(report.title, "통신 지연 분석 및 근본 원인 조사 요청");
  assert.ok(report.analysis.includes("병목 식별 지표 안내 요청"));
  assert.equal(report.result, "우회 조치를 확인하여 고객사에 전달 완료");
});

/* ------------------------------------------------------------------ *
 * 단계 조율 — 가짜 chat 으로
 * ------------------------------------------------------------------ */

interface Call {
  system: string;
  user: string;
  options?: ChatOptions;
}

/** 시스템 프롬프트의 첫 줄로 어느 단계인지 가른다. */
function fakeChat(calls: Call[], overrides: Record<string, string> = {}) {
  return async (system: string, user: string, options?: ChatOptions): Promise<string> => {
    calls.push({ system, user, options });
    for (const [marker, reply] of Object.entries(overrides)) {
      if (system.includes(marker)) return reply;
    }
    if (system.includes("추출기")) {
      return '{"facts":[{"actor":"TAC","at":"01-January-2026","text":"확인함","metrics":"1초"}],"environment":["env"],"ruled_out":[]}';
    }
    if (system.includes("제목 한 줄")) return "통신 지연 분석 요청";
    if (system.includes("질의 내용")) return "업그레이드 이후 지연 발생 확인";
    if (system.includes("원인 분석")) return "현상 파악: 지연 확인함";
    if (system.includes("경과와 향후 방향")) return "후속 조치 방향: 영구 수정 반영 예정";
    if (system.includes("최종 결과")) return "우회 조치를 확인하여 고객사에 전달 완료";
    throw new Error(`알 수 없는 단계: ${system.slice(0, 40)}`);
  };
}

// 이 불변식이 깨지면 다시 잘린 보고서가 나온다.
test("모든 호출이 엔드포인트 출력 상한 아래에서 요청한다", async () => {
  const calls: Call[] = [];
  await composeSrReport(fakeChat(calls), META, THREADS);
  assert.ok(calls.length > 1, "한 번에 끝내면 분해한 의미가 없다");
  for (const call of calls) {
    assert.ok((call.options?.maxTokens ?? Infinity) <= CALL_MAX_TOKENS, JSON.stringify(call.options));
    assert.ok(CALL_MAX_TOKENS < 512, "엔드포인트 상한보다 낮게 잡아야 잘리지 않는다");
    assert.equal(call.options?.temperature, 0);
  }
});

test("조립 결과가 파서를 통과해 세 칸이 모두 찬다", async () => {
  const raw = await composeSrReport(fakeChat([]), META, THREADS);
  assert.ok(isComplete(parseSrReport(raw)), raw);
});

// 34개 스레드 중 하나 때문에 보고서를 통째로 잃는 것이 더 나쁘다.
test("한 묶음이 실패해도 나머지 사실은 살린다", async () => {
  let seen = 0;
  const chat = async (system: string): Promise<string> => {
    if (!system.includes("추출기")) throw new Error("이 시험은 1단계만 부른다");
    seen++;
    if (seen === 1) throw new Error("호출 실패");
    return '{"facts":[{"actor":"CUSTOMER","at":"","text":"로그 제출","metrics":""}],"environment":[],"ruled_out":[]}';
  };
  const got = await extractFacts(chat, META, THREADS, 4);
  assert.equal(seen, 3, "9개를 4개씩 묶으면 3번 부른다");
  assert.ok(got.facts.length > 0, "남은 묶음의 사실은 살아야 한다");
});

// 빈 보고서를 성공으로 돌려주면 "만들어졌다" 로 오해한다.
test("사실을 하나도 못 뽑으면 던진다", async () => {
  const chat = async (): Promise<string> => '{"facts":[],"environment":[],"ruled_out":[]}';
  await assert.rejects(() => composeSrReport(chat, META, THREADS), /사실을 하나도/);
});

test("경과 단계는 이미 쓴 원인 분석을 함께 받는다", async () => {
  const calls: Call[] = [];
  await composeSrReport(fakeChat(calls), META, THREADS);
  const course = calls.find((c) => c.system.includes("경과와 향후 방향"));
  assert.ok(course, "경과 단계가 호출되지 않았다");
  assert.ok(course.user.includes("현상 파악: 지연 확인함"), course.user);
});
