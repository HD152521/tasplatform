import { NextResponse } from "next/server";
import { OpenAiError, chat, hasOpenAi } from "../../../../lib/aiChat.ts";
import {
  buildDraftUser,
  parseComposed,
  readMode,
  stripUngroundedTag,
  systemPromptFor,
} from "../../../../lib/srDraftPrompt.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 본문 한 건이라 요약보다 가볍지만, 사내 LLM 이 밀릴 때를 감안한다.
export const maxDuration = 180;

/** 담당자가 적은 한국어 길이 상한. 실측 최초등록 본문 최대가 6,531자였다. */
const CONTENT_LIMIT = 12_000;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** 한국어 내용을 Broadcom 에 보낼 영문 본문으로 정리한다. 등록은 하지 않는다. */
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
      { ok: false, message: "정리할 내용을 먼저 적어주세요." },
      { status: 400 },
    );
  }
  if (content.length > CONTENT_LIMIT) {
    return NextResponse.json(
      { ok: false, message: `내용이 너무 깁니다 (${content.length}자 / 최대 ${CONTENT_LIMIT}자).` },
      { status: 400 },
    );
  }
  if (!(await hasOpenAi())) {
    return NextResponse.json(
      { ok: false, message: "LLM 연결이 없습니다. 설정 > LLM 연결에서 붙여주세요." },
      { status: 503 },
    );
  }

  try {
    const mode = readMode(body.mode);
    const productName = str(body.productName);
    const componentName = str(body.componentName);
    const release = str(body.release);
    const subject = str(body.subject);

    const answer = await chat(
      systemPromptFor(mode),
      buildDraftUser({
        content,
        mode,
        productName,
        componentName,
        release,
        severity: str(body.severity),
        subject,
      }),
    );
    const composed = parseComposed(answer);
    if (composed.content === "") {
      return NextResponse.json(
        { ok: false, message: "정리 결과가 비어 있습니다. 다시 시도해 주세요." },
        { status: 502 },
      );
    }

    // 제목 앞 대괄호는 담당자가 "어떤 제품·컴포넌트가 문제인지" 보고 적는 자리다.
    // 모델이 없는 버전을 지어 붙인 적이 있어(본문은 TPCF 10.4 인데 [TAS 2.3.4]),
    // 근거가 없으면 떼어낸다. 담당자가 이미 적어 둔 제목도 근거로 인정한다.
    const facts = [release, productName, componentName, subject, content].join(" ");
    composed.subject = stripUngroundedTag(composed.subject, facts);

    return NextResponse.json({ ok: true, ...composed });
  } catch (error) {
    // 실패를 빈 결과로 돌려주지 않는다. 담당자가 원문을 잃지 않게 이유를 그대로 알린다.
    const message = error instanceof OpenAiError || error instanceof Error
      ? error.message
      : String(error);
    return NextResponse.json({ ok: false, message }, { status: 502 });
  }
}
