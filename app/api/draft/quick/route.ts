/**
 * 간단히 올리기 — 한국어 한 덩어리로 등록할 값을 **전부** 만들어 돌려준다.
 *
 * ## 등록은 하지 않는다
 *
 * 여기서 바로 포털에 보내지 않는다. 결과를 돌려주고, 화면이 사람에게 보여준 뒤
 * **기존 `/api/create`** 로 올린다. 등록 경로를 하나로 두는 이유는 그쪽에 이미
 * 세션 재시도와 감사 로그가 붙어 있어서다 — 두 번째 등록 경로를 만들면 그 둘이
 * 한쪽에만 붙는 날이 온다.
 *
 * ## 순서가 분류 → 정리인 이유
 *
 * `/api/draft/compose` 는 `productName`·`componentName` 을 **문맥으로 받아** 더 나은
 * 초안을 만든다(제품·버전을 문단에 녹인다). 그래서 제품을 먼저 정하고 그 이름을
 * 넘긴다. 순서를 바꾸면 초안이 제품을 모르는 상태로 쓰인다.
 *
 * ## 분류가 실패해도 멈추지 않는다
 *
 * LLM 이 없거나 답이 쓸 수 없으면 **가장 많이 쓴 조합**으로 떨어진다(lib/classifyCase.ts).
 * 그 사실을 `fallback: true` 로 올려 보내고 화면이 표시한다. 조용히 기본값을 쓰면
 * 사람은 AI 가 고른 줄 안다.
 */
import { NextResponse } from "next/server";
import { chat, chatFailureMessage, hasOpenAi } from "../../../../lib/aiChat.ts";
import {
  CLASSIFY_SYSTEM_PROMPT,
  buildClassifyUser,
  resolveClassification,
  type Choice,
} from "../../../../lib/classifyCase.ts";
import { mergeCatalog } from "../../../../lib/productCatalog.ts";
import { listProductComponents } from "../../../../lib/queries.ts";
import {
  DRAFT_CONTENT_LIMIT,
  buildDraftUser,
  parseComposed,
  stripUngroundedTag,
  systemPromptFor,
} from "../../../../lib/srDraftPrompt.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 모델을 두 번 부른다(분류 + 정리). 사내 LLM 이 밀릴 때를 감안해 compose 와 같게 둔다.
export const maxDuration = 180;



const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, message: "잘못된 요청입니다." }, { status: 400 });
  }

  const content = str(body.content);
  if (content === "") {
    return NextResponse.json(
      { ok: false, message: "올릴 내용을 먼저 적어주세요." },
      { status: 400 },
    );
  }
  if (content.length > DRAFT_CONTENT_LIMIT) {
    return NextResponse.json(
      { ok: false, message: `내용이 너무 깁니다 (${content.length}자 / 최대 ${DRAFT_CONTENT_LIMIT}자).` },
      { status: 400 },
    );
  }

  // 고를 목록. 수집분에 내장 목록을 더한다 — 상세를 받지 않은 환경에서는 DB 가 비어
  // 있어서, 그것만 쓰면 고를 것이 하나도 없다(lib/productCatalog.ts 머리말).
  let choices: Choice[];
  try {
    choices = mergeCatalog(await listProductComponents());
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message: `Product · Component 목록을 읽지 못했습니다: ${
          error instanceof Error ? error.message : String(error)}`,
      },
      { status: 503 },
    );
  }

  const llm = await hasOpenAi();

  // 1) 분류. 모델이 없으면 부르지 않고 폴백으로 간다.
  let answer: string | null = null;
  if (llm) {
    try {
      answer = await chat(CLASSIFY_SYSTEM_PROMPT, buildClassifyUser(content, choices));
    } catch (error) {
      // 분류가 실패해도 **정리는 계속한다.** 제품을 못 고른 것이 글을 못 쓰는 이유는
      // 아니고, 사람은 화면에서 제품만 바꿔 주면 된다.
      //
      // **오류 종류를 가리지 않는다.** 한때 OpenAiError 가 아니면 다시 던졌는데, 사내
      // LLM 은 LlmError 를 던지므로 그게 전부 HTTP 500 이 됐다. 분류는 폴백이 있는
      // 단계라 여기서 멈출 이유가 없다.
      answer = null;
      console.error("[draft/quick] 분류 실패(폴백으로 진행):", chatFailureMessage(error));
    }
  }
  const classified = resolveClassification(answer, choices);
  if (classified === null) {
    return NextResponse.json(
      {
        ok: false,
        message: "고를 수 있는 Product · Component 가 하나도 없습니다. 수집을 한 번 돌려주세요.",
      },
      { status: 503 },
    );
  }

  // 2) 정리. 여기서는 모델이 꼭 있어야 한다 — 영문 본문을 사람이 아니라 모델이 쓴다.
  if (!llm) {
    return NextResponse.json(
      { ok: false, message: "LLM 연결이 없습니다. 설정 > LLM 연결에서 붙여주세요." },
      { status: 503 },
    );
  }

  const { choice } = classified;
  try {
    // "tidy" — 받은 글을 우리 팀 서식으로 **정리**한다(번역만 하는 "translate" 가 아니다).
    // 간단히 올리기는 담당자가 메모처럼 적는 자리라, 문단을 다시 짜 주는 쪽이 맞다.
    const composed = parseComposed(await chat(
      systemPromptFor("tidy"),
      buildDraftUser({
        content,
        mode: "tidy",
        productName: choice.productName,
        componentName: choice.componentName,
        release: "",
        severity: str(body.severity),
        subject: "",
      }),
    ));
    // 제목 앞 대괄호는 근거가 있을 때만 남긴다. compose 라우트와 같은 규칙이다 —
    // 모델이 본문에 없는 버전을 지어 붙인 적이 있다.
    const facts = [choice.productName, choice.componentName, content].join(" ");
    const subject = stripUngroundedTag(composed.subject, facts);

    // 빈 값 판정은 **떼어낸 뒤에** 한다. 제목이 대괄호 태그 하나뿐이면(모델이 실제로
    // 그렇게 낸 적이 있다) 떼고 나면 빈 문자열이 되는데, 떼기 전에 재면 그게 통과해
    // 빈 제목으로 화면까지 간다. 그러면 사람은 올리기를 눌러 /api/create 에서야
    // 거절당한다 — 막다른 길만 하나 늘어난다.
    if (composed.content === "" || subject === "") {
      return NextResponse.json(
        { ok: false, message: "정리 결과가 비어 있습니다. 다시 시도해 주세요." },
        { status: 502 },
      );
    }

    return NextResponse.json({
      ok: true,
      subject,
      content: composed.content,
      // 못 채운 자리. 비어 있지 않으면 화면이 눈에 띄게 보여준다 —
      // "(to be confirmed)" 가 남은 SR 이 고객사 벤더로 나가면 안 된다.
      missing: composed.missing,
      productId: choice.productId,
      productName: choice.productName,
      componentId: choice.componentId,
      componentName: choice.componentName,
      reason: classified.reason,
      fallback: classified.fallback,
    });
  } catch (error) {
    // **다시 던지지 않는다.** chat() 은 OpenAiError 와 LlmError 두 종류를 던지는데,
    // 한쪽만 잡고 나머지를 던지면 화면에 이유 없는 500 만 남는다(chatFailureMessage 주석).
    // 서버 로그에는 원본을 남기고, 화면에는 다듬은 한 줄을 준다.
    console.error("[draft/quick] 정리 실패:", error);
    return NextResponse.json(
      { ok: false, message: chatFailureMessage(error) },
      { status: 502 },
    );
  }
}
