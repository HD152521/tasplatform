import { NextResponse } from "next/server";
import { OpenAiError, chat, hasOpenAi } from "../../../../../lib/aiChat.ts";
import {
  TRANSLATE_LANG,
  TRANSLATE_LIMIT,
  TRANSLATE_SYSTEM_PROMPT,
  cleanTranslation,
  needsTranslation,
} from "../../../../../lib/caseTranslate.ts";
import { KB_TRANSLATE_FIELDS } from "../../../../../lib/kbTranslate.ts";
import { loadTranslations, openDb, saveTranslation } from "../../../../../lib/db.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 칸 수만큼 부른다. 본문이 짧아 대개 금방이지만 사내 LLM 이 밀릴 때를 감안한다.
export const maxDuration = 600;

/**
 * 기술 문서 한 건을 한국어로 번역해 저장한다.
 *
 * 제목과 본문 네 칸을 각각 번역해 text_translations 에 넣는다(scope 는 kb_title 처럼
 * 칸마다 따로). 케이스 대화 번역과 같은 표·같은 프롬프트를 쓴다 — 하는 일이 같다.
 *
 * 이미 번역된 칸과 이미 한국어인 칸은 건너뛴다. 반복해 눌러도 낭비가 없다.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const articleId = Number(id);
  if (!Number.isInteger(articleId) || articleId <= 0) {
    return NextResponse.json({ ok: false, message: "문서 번호가 올바르지 않습니다." }, { status: 400 });
  }
  if (!(await hasOpenAi())) {
    return NextResponse.json(
      { ok: false, message: "LLM 연결이 없습니다. 설정 > LLM 연결에서 붙여주세요." },
      { status: 503 },
    );
  }

  const db = await openDb();
  let done = 0;
  let failed = 0;

  try {
    const columns = KB_TRANSLATE_FIELDS.map((f) => f.column).join(", ");
    const row = await db.get<Record<string, string>>(
      `SELECT ${columns} FROM kb_articles WHERE article_id = ?`,
      [articleId],
    );
    if (row === undefined) {
      return NextResponse.json({ ok: false, message: "그 문서를 찾지 못했습니다." }, { status: 404 });
    }

    const wanted = KB_TRANSLATE_FIELDS.filter((f) => needsTranslation(row[f.column] ?? ""));
    const have = await loadTranslations(
      db, TRANSLATE_LANG,
      wanted.map((f) => ({ scope: f.scope, refId: articleId })),
    );

    for (const field of wanted) {
      if (have.has(`${field.scope}:${articleId}`)) continue;
      try {
        const answer = await chat(
          TRANSLATE_SYSTEM_PROMPT,
          (row[field.column] ?? "").slice(0, TRANSLATE_LIMIT),
        );
        const text = cleanTranslation(answer);
        if (text === "") {
          failed += 1;
          continue;
        }
        await saveTranslation(db, TRANSLATE_LANG, field.scope, articleId, text, "aiChat");
        done += 1;
      } catch {
        // 한 칸이 막혀도 나머지는 계속한다. 없는 칸은 화면에 원문이 그대로 보인다.
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

  if (done === 0 && failed > 0) {
    return NextResponse.json({ ok: false, message: "번역하지 못했습니다." }, { status: 502 });
  }
  return NextResponse.json({ ok: true, done, failed });
}
