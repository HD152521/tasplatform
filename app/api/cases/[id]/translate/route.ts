import { NextResponse } from "next/server";
import { OpenAiError, chat, hasOpenAi } from "../../../../../lib/aiChat.ts";
import {
  TRANSLATE_LANG,
  TRANSLATE_LIMIT,
  TRANSLATE_SYSTEM_PROMPT,
  type TranslateTarget,
  asTranslateScope,
  caseTranslateTargets,
  cleanTranslation,
  pickTarget,
  untranslated,
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

/**
 * 케이스 대화를 한국어로 번역해 저장한다. 이미 있는 것은 건너뛴다.
 *
 * 두 가지로 부른다:
 * - `POST .../translate` — 아직 번역이 없는 글을 한 회차만큼 번역한다(위쪽 "전체 번역").
 * - `POST .../translate?scope=thread&ref=123` — **그 글 하나만** 번역한다(글마다의 버튼).
 *
 * 한 라우트로 합친 이유는 무엇을 번역할지 정하는 판정(한국어 원문 제외, 이미 있는 것
 * 제외, 케이스 경계)이 한 군데여야 두 방식의 상태가 어긋나지 않기 때문이다.
 * 몸통(body)이 아니라 질의 문자열로 받는 것은 app/TranslateButton.tsx 가 본문 없는
 * POST 를 보내기 때문이다 — 보안 공지·기술 문서와 같은 버튼을 그대로 쓴다.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const requestId = Number(id);
  if (!Number.isInteger(requestId)) {
    return NextResponse.json({ ok: false, message: "케이스 번호가 올바르지 않습니다." }, { status: 400 });
  }

  // 한 건만 번역하라는 요청인지 먼저 읽는다. 둘 중 하나만 오면 잘못된 호출이다.
  const query = new URL(request.url).searchParams;
  const rawScope = query.get("scope");
  const rawRef = query.get("ref");
  const single = rawScope !== null || rawRef !== null;
  const scope = asTranslateScope(rawScope);
  // 빈 값·누락을 Number() 가 0 으로 바꿔 "0번 글" 을 찾으러 가지 않게 한다.
  const refId = rawRef !== null && rawRef.trim() !== "" ? Number(rawRef) : Number.NaN;
  if (single && (scope === null || !Number.isInteger(refId))) {
    return NextResponse.json({ ok: false, message: "번역할 글을 찾지 못했습니다." }, { status: 400 });
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

  // 번역할 수 있는 글 전체. 한국어 원문(APAC 엔지니어가 쓴 답변)과 빈 글은 빠져 있다.
  const targets = caseTranslateTargets({
    requestId,
    descriptionText: detail.description_text,
    threads: threads.map((t) => ({ threadId: t.thread_id, bodyText: t.body_text })),
  });

  // 한 건만 요청받았으면 그 한 건으로 좁힌다. 이 목록에 없는 번호는 다른 케이스의
  // 글이거나 번역 대상이 아닌 글이다 — 여기서 걸러 케이스 경계를 지킨다.
  let wanted: TranslateTarget[] = targets;
  if (single && scope !== null) {
    const one = pickTarget(targets, scope, refId);
    if (one === null) {
      return NextResponse.json(
        { ok: false, message: "번역할 영문 본문이 없습니다." },
        { status: 404 },
      );
    }
    wanted = [one];
  }

  const db = await openDb();
  let done = 0;
  let failed = 0;
  let left = 0;

  try {
    const have = await loadTranslations(db, TRANSLATE_LANG, wanted);
    const todo = untranslated(wanted, have);
    // 한 건 요청인데 이미 있으면 부르지 않는다. 화면은 저장된 번역을 그대로 쓴다.
    if (single && todo.length === 0) {
      return NextResponse.json({ ok: true, already: true, done: 0, failed: 0, left: 0 });
    }
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

  // 한 건만 눌렀는데 실패하면 버튼이 오류를 보여야 한다 — 조용히 성공으로 돌리지 않는다.
  if (done === 0 && failed > 0) {
    return NextResponse.json(
      { ok: false, message: "번역하지 못했습니다.", done, failed, left },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, done, failed, left });
}
