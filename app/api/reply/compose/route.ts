import { NextResponse } from "next/server";
import { OpenAiError, chat, hasOpenAi } from "../../../../lib/aiChat.ts";
import { buildReplyUser, cleanReply, replyPromptFor, type ReplyMode } from "../../../../lib/replyPrompt.ts";
import { listThreads } from "../../../../lib/queries.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

/** 답변 길이 상한. 실측 답변 중앙값이 410자라 넉넉하다. */
const CONTENT_LIMIT = 12_000;

function readMode(value: unknown): ReplyMode {
  // 모르는 값이면 번역으로 둔다. 한국어를 그대로 보내는 쪽이 더 나쁘다.
  return value === "tidy" ? "tidy" : "translate";
}

/**
 * 답변 본문을 영문으로 옮기거나 다듬는다. 등록은 하지 않는다.
 *
 * 무엇에 답하는 글인지 알아야 하므로 **상대의 마지막 글을 서버에서 직접 읽어** 함께
 * 넘긴다. 클라이언트가 보낸 텍스트를 믿지 않는다.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, message: "잘못된 요청입니다." }, { status: 400 });
  }

  const content = typeof body.content === "string" ? body.content.trim() : "";
  const requestId = Number(body.requestId);
  if (content === "") {
    return NextResponse.json({ ok: false, message: "옮길 내용을 먼저 적어주세요." }, { status: 400 });
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

  // 상대의 마지막 글. 없으면 그냥 빈 값으로 간다(참고용이라 없어도 된다).
  let lastIncoming = "";
  if (Number.isInteger(requestId) && requestId > 0) {
    try {
      const threads = await listThreads(requestId);
      for (let i = threads.length - 1; i >= 0; i -= 1) {
        const thread = threads[i];
        if (thread !== undefined && thread.is_ours === 0 && thread.body_text.trim() !== "") {
          lastIncoming = thread.body_text;
          break;
        }
      }
    } catch {
      // 못 읽어도 변환은 계속한다.
    }
  }

  try {
    const mode = readMode(body.mode);
    const answer = await chat(replyPromptFor(mode), buildReplyUser(content, lastIncoming, mode));
    const text = cleanReply(answer);
    if (text === "") {
      return NextResponse.json(
        { ok: false, message: "결과가 비어 있습니다. 다시 시도해 주세요." },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, content: text });
  } catch (error) {
    const message = error instanceof OpenAiError || error instanceof Error
      ? error.message
      : String(error);
    return NextResponse.json({ ok: false, message }, { status: 502 });
  }
}
