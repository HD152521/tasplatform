/**
 * SR 보고서 단계별 프롬프트와 호출 조율.
 *
 * 설계 근거와 단계 구성은 lib/srPipeline.ts 머리말에 있다. 여기는 "무엇을 물어볼
 * 것인가"와 "몇 개씩 동시에 부를 것인가"만 담는다.
 *
 * 프롬프트를 절마다 쪼갠 이유 — 한 번에 하나만 시키면 지시가 짧아진다. 31B 급 모델은
 * 표 세 개와 금지 목록을 동시에 붙들지 못한다. 절마다 그 절에 필요한 규칙만 준다.
 *
 * server-only 를 붙이지 않는다. chat 을 인자로 받아 테스트에서 가짜를 넣는다.
 */
import { promptOverride } from "./prompts.ts";
import { dedupeThreads } from "./srSource.ts";
import {
  BATCH_SIZE,
  CALL_MAX_TOKENS,
  CALL_TIMEOUT_MS,
  type ChatFn,
  type Extraction,
  type SourceThread,
  assembleReport,
  batchThreads,
  cleanSection,
  firstLine,
  mergeExtractions,
  parseFactJson,
  renderBatch,
  renderFacts,
} from "./srPipeline.ts";

/** 사내 엔드포인트를 한꺼번에 두드리지 않는다. */
export const MAX_CONCURRENCY = 3;

/** 공통 문체 규칙. 절마다 필요한 것만 덧붙여 쓴다. */
const STYLE = `- 원본에 없는 단어·사실·수치를 만들지 않는다.
- 출력은 한국어. 제품명·컴포넌트명 등 고유명사는 영문 유지.
- 파일 경로, 파일명, 명령어, 로그 문자열, 에러 클래스명을 직접 쓰지 않고 기능·역할로 대체한다.
- 영문 용어 뒤 괄호 한국어 병기 금지. (예: Scope(범위) → Scope)
- 보고서 외의 설명, 인사말, 마크다운 코드펜스를 출력하지 않는다.`;

const FACTS_SYSTEM = `너는 Broadcom TAC SR 대화에서 사실만 뽑아내는 추출기다.
주어진 대화 조각에서 확인 가능한 사실만 JSON 으로 출력한다. 해석·요약·추론을 하지 않는다.

출력은 아래 JSON 하나뿐이다. 설명도 코드펜스도 붙이지 않는다.
{"facts":[{"actor":"TAC 또는 CUSTOMER","at":"날짜","text":"한 문장","metrics":"수치·버전·설정값, 없으면 빈 문자열"}],
 "environment":["대상 환경 이름, 버전, 설정 항목과 값"],
 "ruled_out":[{"hypothesis":"검토했으나 원인이 아닌 것으로 밝혀진 가설","why":"아닌 이유"}]}

# 반드시 지킬 것
- actor 는 그 말을 한 쪽이다. "--- 고객사 ---" 아래 내용은 CUSTOMER, "--- Broadcom TAC ---" 아래는 TAC.
  추측하지 말고 머리글 그대로 따른다.
- 상대가 "이미 조치된 것으로 보인다", "해당 없음", "이 경우는 아니다" 라고 하며 배제한 가설은
  facts 가 아니라 ruled_out 에 넣는다. 참고로 언급된 알려진 이슈나 KB 를 원인으로 올리지 않는다.
- 수치(지연 시간, 패킷 수, 버전, 설정값)는 절대 버리지 않는다. metrics 또는 environment 에 남긴다.
- 대화 조각에 없는 내용은 만들지 않는다. 뽑을 것이 없으면 빈 배열을 돌려준다.`;

const TITLE_SYSTEM = `너는 SR 보고서의 제목 한 줄만 쓴다.
Subject 와 사실 목록을 보고 현상 또는 요청 목적이 드러나는 한국어 제목을 만든다.

- 명사형으로 끝낸다. (예: 통신 지연 분석 및 근본 원인 조사 요청)
- 한 줄만 출력한다. 기호·따옴표·설명을 붙이지 않는다.
${STYLE}`;

const INQUIRY_SYSTEM = `너는 SR 보고서의 "질의 내용" 절만 쓴다.
고객이 무엇을 궁금해했고 무엇을 요청했는지만 다룬다. TAC 이 한 일은 쓰지 않는다.

- 첫 항목은 배경·상황 중심, 이후 항목은 구체적 요청·질문 중심.
- 항목 수는 2~4개. 항목 구분은 빈 줄만 쓴다. 글머리 기호 금지.
- 대상 환경 수와 이름, 버전, 설정값은 생략하지 않고 관련 항목 안에 함께 적는다.
- "TAC", "TAC 검토 요청" 등 응대 주체를 지칭하지 않는다. 검토 대상과 목적만 쓴다.

## 종결 형식 (서술형 어미 금지, 명사형 단독 종결)
금지: ~요청함 / ~확인함 / ~필요함 / ~한 상태 / ~인 상황
허용: ~발생 / ~확인 / ~점검 / ~수립 가이드 요청 / ~지원 요청
${STYLE}`;

const CAUSE_SYSTEM = `너는 SR 보고서 "진행 상황"의 앞부분, 원인 분석 2~3항목만 쓴다.

- "라벨: 내용" 형식. 한 줄에 한 항목. 기호 없음.
- 라벨 예시: 현상 파악 / 로그 분석 / 근본 원인 규명 / 세부 지표 확인
- 어떤 관측에서 어떤 결론에 이르렀는지 인과를 유지한다. 조치 방향은 여기 쓰지 않는다.
- 관측 수치(지연 시간, 패킷 흐름, 설정값)를 문장 안에 녹여 반드시 넣는다.
- 배제된 가설을 원인으로 쓰지 않는다. 필요하면 "~는 해당 없음으로 확인" 처럼 배제 사실만 적는다.
- TAC 이 확정하지 않고 추정한 것은 "~로 추정" 으로 적는다.
- 명사형 종결: ~함 / ~임 / ~확인됨 / ~파악됨
${STYLE}`;

const COURSE_SYSTEM = `너는 SR 보고서 "진행 상황"의 뒷부분, 경과와 향후 방향 2~3항목만 쓴다.

- "라벨: 내용" 형식. 한 줄에 한 항목. 기호 없음.
- 라벨 예시: TAC 권고사항 / 고객사 조치 / 추가 안내 / 엔지니어링 대응 확인 / 후속 조치 방향
- TAC 이 한 일과 고객사가 한 일을 반드시 다른 항목으로 나눈다.
  TAC 안내는 "~안내받음/~파악됨", 고객 수행은 "~확인/~제출/~조치".
- 우회 조치와 영구 수정을 구분해서 적는다.
- 마지막 항목은 반드시 향후 조치 방향이다.
${STYLE}`;

const RESULT_SYSTEM = `너는 SR 보고서의 "최종 결과" 한 문장만 쓴다.

- 진행 상황의 마지막 흐름을 한 문장으로 요약한다.
- 조치 완료 여부와 고객 전달 여부를 반드시 포함한다.
- 종료된 케이스: "~을 확인하여 고객사에 전달 완료"
- 진행 중인 케이스: "~을 기반으로 단계적 조치 예정"
- 한 줄만 출력한다. 기호·설명을 붙이지 않는다.
${STYLE}`;

/** 프롬프트는 전부 환경변수로 덮어쓸 수 있다. 기존 SR_PROMPT_SR_REPORT 와 같은 방식이다. */
const PROMPTS = {
  facts: () => promptOverride("SR_PROMPT_SR_FACTS", FACTS_SYSTEM),
  title: () => promptOverride("SR_PROMPT_SR_TITLE", TITLE_SYSTEM),
  inquiry: () => promptOverride("SR_PROMPT_SR_INQUIRY", INQUIRY_SYSTEM),
  cause: () => promptOverride("SR_PROMPT_SR_CAUSE", CAUSE_SYSTEM),
  course: () => promptOverride("SR_PROMPT_SR_COURSE", COURSE_SYSTEM),
  result: () => promptOverride("SR_PROMPT_SR_RESULT", RESULT_SYSTEM),
};

export interface CaseMeta {
  requestId: string;
  subject: string;
  status: string;
  priority: string;
  product: string;
  createdOn: string;
  closedOn: string;
  description: string;
}

function metaHeader(meta: CaseMeta): string {
  return [
    `SR No.: ${meta.requestId}`,
    `Subject: ${meta.subject}`,
    `Product: ${meta.product}`,
    `Status: ${meta.status}`,
    `Opened: ${meta.createdOn}`,
    `Closed: ${meta.closedOn}`,
  ].join("\n");
}

/** 모든 호출이 같은 조건을 쓴다. 보고서는 없는 문장이 섞이면 안 되므로 temperature 0. */
const CALL = { maxTokens: CALL_MAX_TOKENS, temperature: 0, timeoutMs: CALL_TIMEOUT_MS } as const;

/** 동시 호출 수를 묶어 순서대로 흘려보낸다. */
async function pooled<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await run(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 1단계. 스레드 묶음마다 사실을 뽑는다.
 *
 * 한 묶음이 깨져도 나머지는 살린다 — 34개 스레드 중 하나 때문에 보고서를 통째로
 * 잃는 것이 더 나쁘다. 전부 실패했는지는 부르는 쪽이 판정한다.
 */
export async function extractFacts(
  chat: ChatFn,
  meta: CaseMeta,
  threads: readonly SourceThread[],
  batchSize: number = BATCH_SIZE,
): Promise<Extraction> {
  // 중복은 여기서 한 번만 건다. 이 경로는 buildSourceText 를 거치지 않는다.
  const batches = batchThreads(dedupeThreads(threads), batchSize);
  const header = metaHeader(meta);

  const parts = await pooled(batches, MAX_CONCURRENCY, async (batch) => {
    try {
      const raw = await chat(PROMPTS.facts(), `${header}\n\n${renderBatch(batch)}`, CALL);
      return parseFactJson(raw);
    } catch {
      // 호출 실패도 빈 결과로 본다. 여기서 던지면 나머지 묶음까지 버려진다.
      return { facts: [], environment: [], ruledOut: [] };
    }
  });
  return mergeExtractions(parts);
}

/**
 * 3단계. 절마다 따로 부른다.
 *
 * 제목·질의 내용·원인 분석은 서로 독립이라 같이 보낸다. 경과는 원인 뒤에 와야 말이
 * 이어지고, 최종 결과는 경과를 요약하는 것이라 순서대로 부른다.
 */
export async function composeSections(
  chat: ChatFn,
  meta: CaseMeta,
  extraction: Extraction,
): Promise<{ title: string; inquiry: string; progress: string; result: string }> {
  const header = metaHeader(meta);
  const facts = renderFacts(extraction);
  const base = `${header}\n\n=== 최초 문의 ===\n${meta.description.trim() || "(없음)"}\n\n${facts}`;

  const [title, inquiry, cause] = await Promise.all([
    chat(PROMPTS.title(), base, CALL),
    chat(PROMPTS.inquiry(), base, CALL),
    chat(PROMPTS.cause(), base, CALL),
  ]);

  const causeText = cleanSection(cause);
  const course = cleanSection(
    await chat(PROMPTS.course(), `${base}\n\n=== 이미 작성된 원인 분석 ===\n${causeText}`, CALL),
  );
  const progress = [causeText, course].filter((s) => s !== "").join("\n");

  const result = await chat(
    PROMPTS.result(),
    `${header}\n\n=== 진행 상황 ===\n${progress}`,
    CALL,
  );

  return {
    title: firstLine(title),
    inquiry: cleanSection(inquiry),
    progress,
    result: firstLine(result),
  };
}

/** 1~4단계를 이어 붙여 기존 양식의 보고서 원문을 만든다. */
export async function composeSrReport(
  chat: ChatFn,
  meta: CaseMeta,
  threads: readonly SourceThread[],
): Promise<string> {
  const extraction = await extractFacts(chat, meta, threads);
  if (extraction.facts.length === 0) {
    // 빈 보고서를 성공으로 돌려주면 "만들어졌다"로 오해한다.
    throw new Error("대화에서 사실을 하나도 뽑지 못했습니다.");
  }
  const sections = await composeSections(chat, meta, extraction);
  return assembleReport(sections);
}
