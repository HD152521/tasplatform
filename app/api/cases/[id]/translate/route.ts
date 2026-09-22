import { NextResponse } from "next/server";
import { OpenAiError, chat, hasOpenAi } from "../../../../../lib/aiChat.ts";
import {
  TRANSLATE_LANG,
  TRANSLATE_LIMIT,
  TRANSLATE_SYSTEM_PROMPT,
  cleanTranslation,
  needsTranslation,
} from "../../../../../lib/caseTranslate.ts";
import { loadTranslations, openDb, saveTranslation } from "../../../../../lib/db.ts";
import { getCase, listThreads } from "../../../../../lib/queries.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 스레드 수만큼 부른다. 한 회차 상한(MAX_PER_CALL)에 여유를 더해 잡는다.
export const maxDuration = 600;

/**
 * 한 번의 요청에서 번역할 최대 건수.
 *
 * 스레드가 수십 건인 케이스가 있어 전부 돌리면 연결이 끊긴다. 나눠서 부르고,
 * 화면은 남은 건수를 보고 다시 부른다.
 */
const MAX_PER_CALL = 8;

/** 케이스 대화를 한국어로 번역해 저장한다. 이미 있는 것은 건너뛴다. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const requestId = Number(id);
  if (!Number.isInteger(requestId)) {
    return NextResponse.json({ ok: false, message: "케이스 번호가 올바르지 않습니다." }, { status: 400 });
  }
  if (!(await hasOpenAi())) {
    return NextResponse.json(
      { ok: false, message: "LLM 연결이 없습니다. 설정 > LLM 연결에서 붙여주세요." },
      { status: 503 },
    );
  }

  const detail = await getCase(requestId);
  if (detail === null) {
    return NextResponse.json({ ok: false, message: "케이스를 찾지 못했습니다." }, { status: 404 });
  }
  const threads = await listThreads(requestId);

  // 번역해야 하는 것만 추린다. 이미 한국어인 글(APAC 엔지니어가 쓴 답변)은 건너뛴다.
  const wanted: Array<{ scope: string; refId: number; text: string }> = [];
  if (needsTranslation(detail.description_text)) {
    wanted.push({ scope: "case_desc", refId: requestId, text: detail.description_text });
  }
  for (const t of threads) {
    if (needsTranslation(t.body_text)) {
      wanted.push({ scope: "thread", refId: t.thread_id, text: t.body_text });
    }
  }

  const db = await openDb();
  let done = 0;
  let failed = 0;
  let left = 0;

  try {
    const have = await loadTranslations(db, TRANSLATE_LANG, wanted);
    const todo = wanted.filter((w) => !have.has(`${w.scope}:${w.refId}`));
    left = Math.max(0, todo.length - MAX_PER_CALL);

    for (const item of todo.slice(0, MAX_PER_CALL)) {
      try {
        const answer = await chat(
          TRANSLATE_SYSTEM_PROMPT,
          item.text.slice(0, TRANSLATE_LIMIT),
        );
        const text = cleanTranslation(answer);
        // 빈 번역을 저장하면 다음에도 원문이 안 나오고 빈칸만 남는다.
        if (text === "") {
          failed += 1;
          continue;
        }
        await saveTranslation(db, TRANSLATE_LANG, item.scope, item.refId, text, "aiChat");
        done += 1;
      } catch {
        // 한 건이 막혀도 나머지는 계속한다. 저장이 안 된 건은 화면에 원문이 그대로 보인다.
        failed += 1;
      }
    }
  } catch (error) {
    const message = error instanceof OpenAiError || error instanceof Error
      ? error.message
      : String(error);
    return NextResponse.json({ ok: false, message }, { status: 502 });
  } finally {
    await db.close();
  }

  return NextResponse.json({ ok: true, done, failed, left });
}
