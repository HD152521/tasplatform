/**
 * 한국어로 적은 내용에서 Product · Component 를 고른다.
 *
 * ## 왜 모델 답을 그대로 쓰지 않나
 *
 * `componentId` 는 **포털이 쓰는 실제 값**이다(lib/productCatalog.ts 머리말). 지어낸
 * 값을 넣으면 거절당하는 게 아니라 **엉뚱한 제품으로 등록된다** — 그걸 나중에 알아채면
 * 이미 고객사 벤더에 다른 제품의 SR 이 올라가 있다.
 *
 * 그래서 모델에게는 **목록에서 하나 고르게** 하고, 돌아온 값이 그 목록에 실제로 있는
 * 쌍인지 다시 확인한다. 없으면 버리고 폴백으로 간다. 모델이 그럴듯한 숫자를 지어내도
 * 통과하지 않는다.
 *
 * ## 폴백은 가장 많이 쓴 조합이다
 *
 * LLM 연결이 없거나 답이 쓸 수 없을 때, 비워 두거나 실패시키면 사람이 할 일이 늘어난다.
 * 우리가 **실제로 가장 많이 올린 조합**으로 떨어지고, 그 사실을 화면에 표시한다.
 * 기본값이 조용히 쓰이는 것이 가장 나쁘다 — 사람은 AI 가 고른 줄 안다.
 *
 * ## 순수 함수만 둔다
 *
 * 프롬프트·파싱·검증·폴백이 전부 여기 있다. LLM 호출은 라우트가 한다. 이 규칙이 틀리면
 * 잘못된 제품으로 SR 이 올라가는데, 그건 올려 보기 전까지 모른다 — 그래서 시험으로 잠근다.
 */

/** 분류에 쓰는 목록의 한 줄. lib/queries.ts 의 ProductComponent 와 같은 모양이다. */
export interface Choice {
  readonly productId: number;
  readonly productName: string;
  readonly componentId: number;
  readonly componentName: string;
  /** 지금까지 이 조합으로 올린 건수. 폴백과 보기 순서를 정한다. */
  readonly used: number;
}

export interface Classified {
  readonly choice: Choice;
  /** 모델이 적은 한 줄 이유. 폴백이면 빈 문자열. */
  readonly reason: string;
  /** 모델 답을 쓰지 못해 기본값으로 떨어졌나. 화면에 반드시 표시한다. */
  readonly fallback: boolean;
}

/**
 * 목록의 한 줄을 가리키는 코드. **`productId-componentId` 쌍이다.**
 *
 * ## 왜 componentId 하나로는 안 되나
 *
 * `componentId` 가 카탈로그에서 **유일하지 않다.** 실측 5건이 서로 다른 제품에 같은
 * 번호로 걸려 있다 — 예를 들어 9453 은 `Tanzu Gemfire` 와 `Tanzu Data Suite` 양쪽에
 * 있고, 8 은 `Product Entitlements` 와 `Support Portal` 양쪽에 있다.
 *
 * 번호 하나만 받아 찾으면 **배열에서 먼저 나오는 것**이 걸린다. 모델이 Data Suite 를
 * 뜻하고 그렇게 이유까지 적어도 Gemfire 로 등록되고, 그때 `fallback` 은 false 다 —
 * 즉 "자신 있게 고른 것" 으로 보여 화면 경고도 뜨지 않는다. 가장 나쁜 모양이다.
 *
 * 그래서 쌍으로 다룬다. 목록에 적는 코드와 찾을 때 쓰는 코드를 **같은 함수**로 만든다.
 */
export function codeOf(choice: Pick<Choice, "productId" | "componentId">): string {
  return `${choice.productId}-${choice.componentId}`;
}

/**
 * 모델이 답을 적는 모양. 한 줄짜리라 JSON 을 요구하지 않는다 —
 * 사내 LLM 이 JSON 모드를 지원하지 않을 수 있고, 한 값이면 이게 더 튼튼하다.
 *
 * 뒤에 군더더기가 붙어도 읽는다(`PICK: 4322-9695 (Diego)`). 끝을 `$` 로 막아 두었더니
 * 모델이 괄호로 설명을 덧붙이는 흔한 경우에 통째로 폴백으로 떨어졌다.
 */
const PICK_LINE = /^\s*PICK\s*[:=]\s*(\d{1,9})\s*-\s*(\d{1,9})/im;
const REASON_LINE = /^\s*REASON\s*[:=]\s*(.+)$/im;

export const CLASSIFY_SYSTEM_PROMPT = [
  "당신은 VMware Tanzu / Cloud Foundry 를 운영하는 한국 기술지원팀의 엔지니어입니다.",
  "담당자가 한국어로 적은 장애·문의 내용을 읽고, Broadcom 지원 포털에 SR 을 올릴 때",
  "고를 **Product · Component 한 줄**을 정합니다.",
  "",
  "# 규칙",
  "- 아래 목록의 코드 중에서만 고릅니다. 코드를 **그대로 옮겨 적습니다.**",
  "  같은 컴포넌트 이름이 제품을 달리해 여러 번 나올 수 있으니 코드로 구분합니다.",
  "- 확실하지 않으면 **가장 자주 쓰인 줄**(목록 위쪽)을 고릅니다. 비워 두지 않습니다.",
  "- 증상이 여러 구성요소에 걸치면 **담당자가 고쳐야 할 쪽**을 고릅니다.",
  "",
  "# 답하는 모양",
  "정확히 두 줄로만 답합니다. 다른 말은 붙이지 않습니다.",
  "",
  "PICK: <코드>",
  "REASON: <한국어로 한 줄. 왜 그 제품·컴포넌트인지>",
].join("\n");

/**
 * 고를 수 있는 목록을 프롬프트에 싣는다.
 *
 * 많이 쓴 순으로 **정렬해서** 넣는다. 모델이 앞쪽을 기본값처럼 다루므로, 그 앞쪽이
 * 우리가 실제로 많이 올리는 조합이어야 한다. 건수 자체는 싣지 않는다 — 이 저장소는
 * 공개이고 컴포넌트별 건수는 우리 업무 구성을 드러낸다(productCatalog.ts 와 같은 이유).
 */
export function buildChoiceList(choices: readonly Choice[]): string {
  return sortByUse(choices)
    .map((c) => `${codeOf(c)}\t${c.productName} > ${c.componentName}`)
    .join("\n");
}

export function buildClassifyUser(content: string, choices: readonly Choice[]): string {
  return [
    "# 고를 수 있는 목록 (코드\t제품 > 컴포넌트)",
    buildChoiceList(choices),
    "",
    "# 담당자가 적은 내용",
    content.trim(),
  ].join("\n");
}

/** 많이 쓴 순, 같으면 이름 순. 순서가 흔들리면 프롬프트도 흔들린다. */
function sortByUse(choices: readonly Choice[]): Choice[] {
  return [...choices].sort((a, b) =>
    b.used - a.used
    || a.productName.localeCompare(b.productName)
    || a.componentName.localeCompare(b.componentName));
}

/** 모델 답에서 고른 쌍과 이유를 꺼낸다. 못 읽으면 null. */
export function parseClassified(
  text: string,
): { productId: number; componentId: number; reason: string } | null {
  const pick = PICK_LINE.exec(text);
  if (pick === null) return null;
  const productId = Number(pick[1]);
  const componentId = Number(pick[2]);
  const sane = (n: number): boolean => Number.isSafeInteger(n) && n > 0;
  if (!sane(productId) || !sane(componentId)) return null;
  const reason = (REASON_LINE.exec(text)?.[1] ?? "").trim();
  return { productId, componentId, reason };
}

/**
 * 가장 많이 쓴 조합. 목록이 비면 null — 그때는 SR 을 올릴 수 없다.
 *
 * 목록이 비는 경우가 실제로 있었다. 케이스 상세를 받지 않은 환경에서는 DB 에
 * 조합이 하나도 없다(productCatalog.ts 머리말). 그래서 내장 목록을 더해 쓴다.
 */
export function mostUsed(choices: readonly Choice[]): Choice | null {
  return sortByUse(choices)[0] ?? null;
}

/**
 * 모델 답과 목록을 맞춰 최종 선택을 낸다.
 *
 * `answer` 가 null 이면(LLM 없음·호출 실패) 바로 폴백이다. 답이 있어도 목록에 없는
 * 번호면 폴백이다 — **지어낸 번호로 등록하지 않는다.**
 */
export function resolveClassification(
  answer: string | null,
  choices: readonly Choice[],
): Classified | null {
  const fallbackChoice = mostUsed(choices);
  if (fallbackChoice === null) return null;

  const parsed = answer === null ? null : parseClassified(answer);
  if (parsed === null) return { choice: fallbackChoice, reason: "", fallback: true };

  // **쌍으로 찾는다.** componentId 하나로 찾으면 같은 번호를 쓰는 다른 제품이 걸린다
  // (codeOf 주석). 그 경우 fallback 이 false 라 화면 경고도 뜨지 않는다.
  const wanted = codeOf(parsed);
  const matched = choices.find((c) => codeOf(c) === wanted);
  if (matched === undefined) return { choice: fallbackChoice, reason: "", fallback: true };

  return { choice: matched, reason: parsed.reason, fallback: false };
}
