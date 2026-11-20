/**
 * SR 작성 본문을 Broadcom 에 보낼 영문으로 정리하는 프롬프트.
 *
 * ⚠ 케이스 본문이 AI 로 나간다. lib/aiChat.ts 경유로만 부른다(사내 LLM 우선,
 *   없으면 OPENAI_API_KEY). lib/translate.ts(Gemini/Groq) 로는 절대 보내지 않는다 —
 *   그쪽 머리말의 경고 참고.
 *
 * 틀은 지어내지 않고 **우리가 실제로 올린 최근 120건에서 뽑았다**(2026-09-22 실측):
 *
 *   인사말로 시작        80%
 *   맺음말(Thanks 등)    79%
 *   버전·제품 언급       65%
 *   에러 문구 인용       49%
 *   섹션 제목 사용       22%   ← 대부분 안 쓴다
 *   번호 목록            17%
 *
 * 즉 지배적인 모양은 **인사말 → 제목 없는 줄글 문단 → 질문 → 맺음말** 이다.
 * 문단 수 중앙값은 7. 섹션 제목을 쓴 26건 중 15건이 Questions 계열이라,
 * 제목은 질문 묶음에만 붙인다. Background·Symptom 같은 제목은 쓰지 않는다
 * (Background 는 120건 중 1건뿐이었다).
 *
 * server-only 를 붙이지 않는다. 프롬프트와 파서는 순수 함수라 그대로 테스트한다.
 */

/**
 * 담당자가 적는 한국어 길이 상한.
 *
 * 실측 최초등록 본문 최대가 6,531자였다. 여유를 두고 그 두 배 가까이 잡는다.
 *
 * **두 라우트가 같이 쓴다**(/api/draft/compose, /api/draft/quick). 한때 각자 베껴
 * 두었는데, 한쪽만 바뀌면 사람이 같은 글을 넣고 한쪽에서는 거절당한다.
 */
export const DRAFT_CONTENT_LIMIT = 12_000;

/** 모델이 쓸 수 있는 유일한 섹션 제목. 질문이 있을 때만 붙인다. */
export const QUESTIONS_HEADING = "Questions";

/** 원문에 없어 채울 수 없는 자리. 지어내는 것보다 비워 두는 편이 낫다. */
export const UNKNOWN_MARK = "(to be confirmed)";

/**
 * Jira 티켓(우리 팀 추적용)에 쓸 **한글 제목·본문**을 같은 호출에서 같이 받는다.
 *
 * ## 왜 같은 호출인가
 *
 * 따로 부르면 7~8초가 한 번 더 붙는다. SR 등록은 사람이 화면 앞에서 기다리는 구간이라
 * 그 대가가 크다. 번역·정리는 어차피 원문을 읽고 있으므로, 두 덩어리를 더 받는 쪽은
 * 공짜에 가깝다.
 *
 * ## 왜 코드가 자르지 않나
 *
 * 처음에는 한글 원문의 **첫 줄**을 제목으로, 앞 문단을 본문으로 잘라 썼다. 결과가
 * 이랬다 — `[운영] 앱 두 개가 계속 crash 납니다 진행`. 첫 줄이 문장이면 뒤에 "진행" 이
 * 붙어 말이 되지 않는다. 기존 티켓들은 `[운영] GemFire 비정상 VM 원인 분석 SR 진행`
 * 처럼 **명사구**다. 문장을 명사구로 바꾸는 것은 규칙으로 할 일이 아니다.
 *
 * 대괄호(`[운영]`)와 꼬리말(`진행`)은 **코드가 붙인다**(lib/jiraSrTicket.ts). 모델이
 * 같이 붙이면 두 번 붙는다.
 */
const JIRA_BLOCK = [
  "[JIRA_TITLE]",
  "(우리 팀 Jira 티켓에 쓸 **한글 제목 한 줄**. 목록에서 무슨 일인지 읽히게 씁니다.",
  " - **명사구로 씁니다.** 문장으로 쓰지 않습니다.",
  "   좋음: `Diego cell 앱 반복 crash 원인 분석`",
  "   나쁨: `앱 두 개가 계속 crash 납니다`",
  " - 제품·버전이 원문에 있으면 앞에 넣습니다. 예: `TPCF 10.4.2 앱 반복 crash 원인 분석`",
  " - `[운영]`·`[개발]` 같은 대괄호와 끝의 `진행` 은 **붙이지 않습니다.** 코드가 붙입니다.",
  " - 40자 안쪽으로 씁니다.)",
  "",
  "[JIRA_BODY]",
  "(같은 티켓의 **한글 본문**. 우리 팀이 나중에 이 티켓만 보고 무슨 건이었는지 알 만큼",
  " 짧게 씁니다. 고객에게 보내는 글이 아닙니다.",
  " - `배경` 과 `질문` 두 줄머리로, **이 순서로** 나눠 각 1~3줄.",
  "   `질문` 은 **우리가 Broadcom 에 묻는 것**입니다. 원문에 없어 담당자가 채워야 할",
  "   정보를 여기 적지 않습니다 — 그건 [MISSING] 자리입니다. 실측으로 모델이 이 둘을",
  "   섞어, 티켓의 질문 칸에 \"발생 시각 정보가 필요합니다\" 가 들어간 적이 있습니다.",
  "   물어볼 것이 원문에 없으면 `질문` 줄머리를 비워 둡니다.",
  " - **개조식으로 씁니다 — 어말어미를 붙이지 않습니다.** `~습니다`·`~입니다`·`~한다`",
  "   로 끝내지 않고 명사나 명사형(`~필요`·`~요청`·`~확인`)으로 끊습니다. 티켓은",
  "   기록이라 문장이 아니라 **항목으로** 읽힙니다. 줄 끝에 마침표도 붙이지 않습니다.",
  "   좋음: `배경: BOSH 가 VM 을 만들 때 AZ 와 vSphere 클러스터에 어떻게 배치하는지 확인 필요`",
  "   좋음: `질문: 공식 문서 링크 제공 및 AZ/클러스터 배치 기준 상세 설명 요청`",
  "   나쁨: `배경: BOSH 가 어떻게 배치하는지 확인이 필요합니다.`",
  " - 원문에 없는 사실을 지어내지 않습니다.",
  " - 에러 문구·명령어·버전은 원문 그대로 옮깁니다.",
  " - 영문 본문을 그대로 옮겨 적지 않습니다 — 한글로 간추립니다.)",
].join("\n");

/**
 * 세 프롬프트가 함께 쓰는 **출력 형식** 지시.
 *
 * 베껴 두면 한쪽만 바뀌는 날이 온다 — 파서(parseComposed)는 다섯 표식을 모두 보므로,
 * 한 프롬프트에서 표식 이름이 어긋나면 그 모드만 조용히 본문 전체를 통째로 싣는다.
 *
 * `contentHint` 만 모드마다 다르다("정리된/다듬은/풀어 쓴 영문 본문 전체").
 */
function outputFormat(contentHint: string): string {
  return [
    "# 출력 형식",
    "아래 다섯 덩어리만 이 순서로 출력합니다. 다른 말은 붙이지 않습니다.",
    "",
    "[SUBJECT]",
    "(영문 제목 한 줄.",
    " 제품·버전을 대괄호로 앞에 붙이는데, **주어진 것에서만** 가져옵니다 —",
    " 케이스 속성의 Prod Release, 또는 본문에 적힌 제품·버전. 예: [TPCF 10.4]",
    " 둘 다 없으면 **대괄호를 아예 쓰지 않습니다.** 제품명이나 버전을 추측해서 만들지",
    " 않습니다. 실제로 본문에 TPCF 10.4 라고 적혀 있는데 [TAS 2.3.4] 를 붙인 적이",
    " 있습니다 — 제품도 버전도 근거 없는 값이었습니다.)",
    "",
    "[CONTENT]",
    `(${contentHint})`,
    "",
    "[MISSING]",
    "(Broadcom 이 되물을 법한데 원문에 없는 정보를 한국어로 한 줄에 하나씩.",
    " 없으면 이 덩어리를 비워 둡니다.)",
    "",
    JIRA_BLOCK,
  ].join("\n");
}

export const DRAFT_SYSTEM_PROMPT = [
  "당신은 VMware Tanzu / Cloud Foundry 를 운영하는 한국 기술지원팀의 엔지니어입니다.",
  "담당자가 한국어로 적은 내용을 Broadcom 지원팀에 보낼 영문 SR 본문으로 정리합니다.",
  "",
  "# 글의 모양",
  "우리 팀이 실제로 쓰는 모양을 그대로 따릅니다.",
  "- `Hello Support Team,` 로 시작합니다.",
  "- 본문은 **제목 없는 영어 문단**으로 씁니다. 운영 환경·제품 버전·증상·이미 해본 것을",
  "  문단 안에 자연스럽게 녹입니다. Background, Symptom, Environment 같은 소제목은",
  "  붙이지 않습니다.",
  `- 물어볼 것이 있으면 마지막 문단 뒤에 \`${QUESTIONS_HEADING}\` 한 줄을 두고 번호로 나열합니다.`,
  "  질문이 하나도 없으면 그 줄을 아예 쓰지 않습니다.",
  "- `Thanks,` 로 맺습니다.",
  "",
  "# 지켜야 할 것",
  "- **원문에 없는 사실을 지어내지 않습니다.** 버전·수치·에러 문구·발생 시각을 추측해서",
  `  채우지 않습니다. 꼭 필요한데 원문에 없으면 \`${UNKNOWN_MARK}\` 로 두고 넘어갑니다.`,
  "- 에러 문구·로그·명령어·경로·설정값은 **원문 그대로** 옮깁니다. 번역하거나 다듬지 않습니다.",
  "- 담당자가 쓴 요청 항목을 빼거나 뭉치지 않습니다. 질문 세 개면 세 개 그대로 둡니다.",
  "- 영어는 평이한 기술 문서체로 씁니다. 과장이나 사과를 덧붙이지 않습니다.",
  "- 고객사 이름은 쓰지 않습니다. 이미 계정으로 식별됩니다.",
  "",
  outputFormat("정리된 영문 본문 전체"),
].join("\n");

/**
 * 이미 영어로 적은 글을 **같은 언어 그대로** 팀 양식으로 다듬는다.
 *
 * 번역과 나눠 둔 이유는 섞이면 둘 다 나빠지기 때문이다. 번역 프롬프트로 영어를
 * 넣으면 모델이 "옮길 것이 없다" 고 보고 원문을 거의 그대로 뱉거나, 반대로
 * 한국어로 옮겨 버린다. 다듬기는 언어를 건드리지 말라고 따로 못박는다.
 */
export const TIDY_SYSTEM_PROMPT = [
  "당신은 VMware Tanzu / Cloud Foundry 를 운영하는 한국 기술지원팀의 엔지니어입니다.",
  "담당자가 **영어로** 적은 SR 본문을 팀 양식에 맞게 다듬습니다.",
  "",
  "# 가장 중요한 것",
  "- **언어를 바꾸지 않습니다.** 영어로 들어온 글은 영어로 나갑니다. 한국어로 옮기지 않습니다.",
  "- **내용을 바꾸지 않습니다.** 사실을 더하거나 빼거나 다른 말로 바꾸지 않습니다.",
  "  문장이 어색해도 뜻이 달라질 바에는 그대로 둡니다.",
  "",
  "# 하는 일",
  "- 우리 팀이 쓰는 모양으로 배치합니다.",
  "  `Hello Support Team,` 로 시작하고, 제목 없는 영어 문단으로 본문을 쓰고,",
  `  물어볼 것이 있으면 \`${QUESTIONS_HEADING}\` 한 줄 뒤에 번호로 나열하고, \`Thanks,\` 로 맺습니다.`,
  "  질문이 하나도 없으면 그 줄을 쓰지 않습니다.",
  "- Background, Symptom, Environment 같은 소제목은 붙이지 않습니다.",
  "- 흩어진 질문을 찾아 Questions 로 모읍니다. 질문 개수와 뜻은 그대로 둡니다.",
  "- 중복된 문장, 군더더기 인사, 깨진 줄바꿈을 정리합니다.",
  "- 에러 문구·로그·명령어·경로·설정값·제품 버전은 **한 글자도 바꾸지 않습니다.**",
  "",
  outputFormat("다듬은 영문 본문 전체"),
].join("\n");

/**
 * 메모 한 줄을 **제대로 된 영문 SR 본문으로 풀어 쓴다** — 간단히 올리기 전용.
 *
 * ## 왜 tidy 로는 안 됐나
 *
 * 간단히 올리기는 처음에 TIDY_SYSTEM_PROMPT 를 썼다. "메모처럼 적는 자리니 문단을
 * 다시 짜 주는 쪽이 맞다" 는 판단이었는데, tidy 의 첫 줄이 **"언어를 바꾸지 않습니다"**
 * 다. 담당자는 한국어로 적으니 그 지시가 그대로 먹혀, 영문 본문 자리에 한국어가
 * 그대로 실렸다. 실제로 이렇게 올라갔다:
 *
 *     Hello Support Team,
 *     마이그레이션 작업하는데 vm에 붙어있던 disk가 기존 az에 계속 남아있음 의돤건지
 *     Questions
 *     1. 마이그레이션 작업하는데 vm에 붙어있던 disk가 기존 az에 계속 남아있음 의돤건지
 *     Thanks,
 *
 * 받는 쪽이 읽을 수 없는 글이고, 질문 칸은 본문을 그대로 베꼈고, 오타(`의돤건지`)까지
 * 그대로 나갔다.
 *
 * ## 이 자리의 일은 '줄이기' 가 아니라 '풀기' 다
 *
 * 담당자는 한두 줄만 적는다. **짧게 적어도 자세히 나가는 것**이 이 기능이고, 받은
 * 글을 짧게 옮기는 것은 기능이 아니다. 그러면서 사실을 늘리지는 않는다 — 늘리는 것은
 * **문장**이고, 버전·수치·에러 문구는 원문에 있는 것만 쓴다. 이 둘을 한 프롬프트에서
 * 같이 못박아야 해서 translate·tidy 와 따로 둔다.
 *
 * 프롬프트만으로 끝내지 않는다. 결과가 한국어로 남거나 메모 수준으로 짧으면 한 번 더
 * 부른다(lib/srDraftQuality.ts) — 지시를 지킬 것이라는 전제 위에 기능을 쌓지 않는다.
 */
export const QUICK_SYSTEM_PROMPT = [
  "당신은 VMware Tanzu / Cloud Foundry 를 운영하는 한국 기술지원팀의 엔지니어입니다.",
  "담당자가 메모처럼 짧게 적은 내용을 Broadcom 지원팀에 보낼 영문 SR 본문으로 **풀어 씁니다.**",
  "",
  "# 가장 중요한 것",
  "- **영어로 씁니다.** 들어온 글이 한국어여도 본문에 한국어를 남기지 않습니다.",
  "  담당자는 한국어로 적고, 받는 쪽은 한국어를 읽지 못합니다. (예외는 아래",
  "  '그대로 옮기는 것' 하나뿐입니다.)",
  "- **짧게 적어도 자세히 나가게 씁니다.** 한 줄을 한 줄로 옮기면 Broadcom 이 되묻기만",
  "  하고 하루가 지나갑니다. 지원팀이 바로 조사에 들어갈 수 있는 글로 만듭니다.",
  "- **그래도 사실은 늘리지 않습니다.** 풀어 쓰는 것은 문장이지 사실이 아닙니다.",
  "",
  "# 어떻게 풀어 쓰나",
  "- 담당자가 적은 조각을 완전한 영어 문장으로 세웁니다. 오타·줄임말·구어는 평이한",
  "  기술 문서체로 고쳐 씁니다. 예: `의돤건지` → `whether this behavior is expected`.",
  "- 케이스 속성으로 주어진 Product · Component · Prod Release 는 **환경으로 한 문단에",
  "  적습니다.** 주어진 값이라 적는 것입니다. 주어지지 않은 것은 적지 않습니다.",
  "- 증상은 **무엇을 하다가 / 무엇을 기대했는데 / 실제로 무엇이 보이는지**로 나눠",
  "  적습니다. 원문에 그 단계가 없으면 그 줄은 비워 둡니다.",
  "- 담당자가 이미 해 본 것·확인한 것이 적혀 있으면 한 문단으로 따로 적습니다.",
  "- 우리가 무엇을 확인받고 싶은지(기대하는 답)를 분명히 적습니다.",
  "- 본문은 **세 문단 이상**을 목표로 합니다. 다만 문단을 채우려고 사실을 만들지",
  "  않습니다 — 쓸 것이 없으면 짧은 채로 둡니다.",
  "",
  "# 지어내지 않는 것",
  "- 버전·수치·호스트명·VM 이름·에러 문구·발생 시각·건수를 추측해서 채우지 않습니다.",
  `  꼭 필요한데 원문에 없으면 \`${UNKNOWN_MARK}\` 로 두거나 아예 쓰지 않습니다.`,
  "- 원문에 없는 영향(`production outage`, `service is down` 등)이나 긴급도를 붙이지 않습니다.",
  "- 하지 않은 조치를 했다고 쓰지 않습니다. `We have already restarted…` 는 원문에 그",
  "  말이 있을 때만 씁니다.",
  "- 원인 추정을 우리 판단인 것처럼 단정하지 않습니다.",
  "- Broadcom 이 되물을 법한데 원문에 없는 것은 본문이 아니라 [MISSING] 에 적습니다.",
  "",
  "# 그대로 옮기는 것",
  "에러 문구·로그·명령어·경로·설정값·식별자는 **한 글자도 바꾸지 않습니다.** 이것만은",
  "한국어여도 그대로 둡니다 — 메시지를 옮겨 적으면 받는 쪽이 검색하지 못합니다.",
  "",
  "# 글의 모양",
  "우리 팀이 실제로 쓰는 모양을 그대로 따릅니다(최근 120건 실측).",
  "- `Hello Support Team,` 로 시작합니다.",
  "- 본문은 **제목 없는 영어 문단**으로 씁니다. Background, Symptom, Environment 같은",
  "  소제목은 붙이지 않습니다.",
  `- 물어볼 것이 있으면 마지막 문단 뒤에 \`${QUESTIONS_HEADING}\` 한 줄을 두고 번호로 나열합니다.`,
  "  **영어 의문문으로 씁니다.** 본문 문장을 그대로 다시 적지 않습니다. 원문의 `~인지`,",
  "  `~맞나요`, `확인 부탁` 은 모두 질문이니 찾아서 의문문으로 세웁니다.",
  "  질문이 하나도 없으면 그 줄을 쓰지 않습니다.",
  "- `Thanks,` 로 맺습니다.",
  "- 고객사 이름은 쓰지 않습니다. 이미 계정으로 식별됩니다.",
  "",
  outputFormat("풀어 쓴 영문 본문 전체"),
].join("\n");

/** 무엇을 시킬 것인가. */
export type DraftMode = "translate" | "tidy" | "quick";

export function readMode(value: unknown): DraftMode {
  // 모르는 값이 오면 번역으로 둔다. 한국어를 영어로 못 바꿔 보내는 쪽이 더 나쁘다.
  if (value === "tidy") return "tidy";
  if (value === "quick") return "quick";
  return "translate";
}

export function systemPromptFor(mode: DraftMode): string {
  if (mode === "tidy") return TIDY_SYSTEM_PROMPT;
  if (mode === "quick") return QUICK_SYSTEM_PROMPT;
  return DRAFT_SYSTEM_PROMPT;
}

export interface DraftContext {
  /** 담당자가 적은 한국어 원문. */
  readonly content: string;
  readonly productName?: string;
  readonly componentName?: string;
  /** 예: "TPCF 10.4" */
  readonly release?: string;
  readonly severity?: string;
  /** 이미 적어 둔 제목. 있으면 모델이 건드리지 않는다. */
  readonly subject?: string;
  /** 번역인가 다듬기인가. 본문 라벨이 달라진다. */
  readonly mode?: DraftMode;
}

/** 모델에게 줄 사용자 메시지. 아는 값은 넘겨 주어 지어내지 않게 한다. */
export function buildDraftUser(ctx: DraftContext): string {
  const facts: string[] = [];
  const add = (label: string, value?: string): void => {
    const v = (value ?? "").trim();
    if (v !== "") facts.push(`${label}: ${v}`);
  };
  add("Product", ctx.productName);
  add("Component", ctx.componentName);
  add("Prod Release", ctx.release);
  add("Severity", ctx.severity);

  const parts = [
    facts.length > 0
      ? `[케이스 속성]\n${facts.join("\n")}`
      : "[케이스 속성]\n(없음 — 본문에서 확인되는 것만 씁니다)",
  ];

  const subject = (ctx.subject ?? "").trim();
  parts.push(
    subject === ""
      ? "[제목]\n(아직 없음 — 만들어 주세요)"
      : `[제목]\n${subject}\n(이미 정해진 제목입니다. 그대로 두세요.)`,
  );

  // 라벨이 모드마다 다른 이유: 같은 글을 받고도 할 일이 다르다. quick 에서는 글이
  // 짧은 것이 **결함이 아니라 전제**라는 것을 알려 줘야 모델이 그대로 베끼지 않는다.
  const label = ctx.mode === "tidy"
    ? "[담당자가 영어로 적은 내용 — 언어를 바꾸지 말고 다듬기만 하세요]"
    : ctx.mode === "quick"
      ? "[담당자가 적은 메모 — 짧은 것이 정상입니다. 영문으로 풀어 쓰세요]"
      : "[담당자가 적은 내용]";
  parts.push(`${label}\n${ctx.content.trim()}`);
  return parts.join("\n\n");
}

export interface ComposedDraft {
  /** 영문 제목. 이미 있던 제목을 그대로 둔 경우도 여기에 담긴다. */
  subject: string;
  /** 등록될 영문 본문. */
  content: string;
  /** 원문에 없어 담당자가 채워야 할 것들. */
  missing: string[];
  /**
   * Jira 티켓에 쓸 한글 제목. 모델이 안 주면 빈 문자열이고, 그때는 부르는 쪽이
   * 원문 첫 줄에서 뽑는다(lib/jiraSrTicket.ts 의 koTitleFrom).
   */
  jiraTitle: string;
  /** 같은 티켓의 한글 본문. 비면 부르는 쪽이 한글 원문을 쓴다. */
  jiraBody: string;
}

/**
 * 모델 응답에서 세 덩어리를 뽑는다.
 *
 * 형식 준수에 기대지 않는다. 표식을 못 찾으면 **전체를 본문으로 본다** —
 * 애써 만든 글을 형식 때문에 버리는 것이 가장 나쁘다.
 */
export function parseComposed(text: string): ComposedDraft {
  const clean = text.replace(/```[a-z]*\n?|```/gi, "").trim();
  const find = (name: string): number => {
    const m = new RegExp(`^\\s*\\[?${name}\\]?\\s*:?\\s*$`, "im").exec(clean);
    return m === null ? -1 : (m.index ?? -1) + m[0].length;
  };
  const starts = {
    subject: find("SUBJECT"),
    content: find("CONTENT"),
    missing: find("MISSING"),
    jiraTitle: find("JIRA_TITLE"),
    jiraBody: find("JIRA_BODY"),
  };

  // 표식이 하나도 없으면 전부 본문이다.
  if (starts.subject === -1 && starts.content === -1) {
    return { subject: "", content: clean, missing: [], jiraTitle: "", jiraBody: "" };
  }

  /** from 에서 시작해, 뒤따르는 다른 표식 앞까지. */
  const slice = (from: number): string => {
    if (from === -1) return "";
    const after = Object.values(starts).filter((i) => i > from);
    const end = after.length > 0 ? Math.min(...after) : clean.length;
    // 다음 표식 줄 자체를 잘라낸다.
    const raw = clean.slice(from, end);
    return raw
      .replace(/\n\s*\[?(SUBJECT|CONTENT|MISSING|JIRA_TITLE|JIRA_BODY)\]?\s*:?\s*$/i, "")
      .trim();
  };

  const missing = slice(starts.missing)
    .split("\n")
    .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
    .filter((l) => l !== "" && !/^\(?(없음|none)\)?\.?$/i.test(l));

  /**
   * 모델이 지시를 어기고 대괄호나 꼬리말을 붙여 오는 경우를 걷어낸다.
   *
   * 코드가 `[운영] … 진행` 으로 감싸므로(lib/jiraSrTicket.ts), 모델이 같이 붙이면
   * `[운영] [운영] … 진행 진행` 이 된다. 지시를 지킬 것이라는 전제 위에 모양을 쌓지
   * 않는다 — 이 파일의 parseComposed 자체가 그 원칙으로 쓰여 있다.
   */
  const cleanJiraTitle = (line: string): string =>
    line
      .replace(/^\s*\[(운영|개발|AWS)\]\s*/i, "")
      .replace(/\s*진행\s*$/, "")
      .trim();

  return {
    // 제목이 여러 줄로 오면 첫 줄만 쓴다.
    subject: (slice(starts.subject).split("\n")[0] ?? "").trim(),
    content: slice(starts.content),
    missing,
    jiraTitle: cleanJiraTitle(slice(starts.jiraTitle).split("\n")[0] ?? ""),
    jiraBody: slice(starts.jiraBody),
  };
}

/* ------------------------------------------------------------------ *
 * 제목 앞 대괄호 검증
 * ------------------------------------------------------------------ */

/**
 * 제목 앞 대괄호가 근거 있는 값인지 보고, 아니면 떼어낸다.
 *
 * 프롬프트로만 막으면 또 샌다. 실제로 본문에 `TPCF 10.4` 라고 적혀 있는데
 * `[TAS 2.3.4]` 가 붙어 나온 일이 있었다 — 제품도 버전도 없는 값이다. 이 대괄호는
 * 담당자가 "어떤 제품·컴포넌트가 문제인지" 보고 적는 자리라, 틀린 값이 붙으면
 * Broadcom 쪽에서 케이스가 엉뚱한 팀으로 갈 수 있다.
 *
 * 판정은 단순하게 한다 — 대괄호 안의 낱말(2자 이상 영문, 또는 10.4 같은 숫자)이
 * **모두** 근거(케이스 속성 + 담당자가 적은 본문)에 있어야 남긴다. 하나라도 없으면
 * 대괄호 전체를 뗀다. 대괄호가 사라지는 것은 담당자가 눈으로 보고 채우면 되지만,
 * 없는 버전이 붙어 나가는 것은 돌이킬 수 없다.
 */
export function stripUngroundedTag(subject: string, facts: string): string {
  const match = /^\s*\[([^\]]{1,60})\]\s*/.exec(subject);
  if (match === null) return subject.trim();

  const tag = match[1] ?? "";
  // 영문 낱말(2자 이상)과 버전 숫자(10, 10.4, 2.3.4)만 본다. 구분기호는 무시한다.
  const tokens = tag.match(/[A-Za-z]{2,}|\d+(?:\.\d+)*/g) ?? [];
  const haystack = facts.toLowerCase();
  const grounded = tokens.length > 0
    && tokens.every((token) => haystack.includes(token.toLowerCase()));

  return grounded ? subject.trim() : subject.slice(match[0].length).trim();
}
