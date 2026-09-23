import { NextResponse } from "next/server";
import { OpenAiError, chat, hasOpenAi } from "../../../../../lib/aiChat.ts";
import {
  TRANSLATE_LIMIT,
  TRANSLATE_SYSTEM_PROMPT,
  cleanTranslation,
  needsTranslation,
} from "../../../../../lib/caseTranslate.ts";
import { openDb } from "../../../../../lib/db.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

/**
 * 보안 공지 설명을 한국어로 번역해 저장한다.
 *
 * 저장은 cves.summary_ko 다 — 화면이 이미 그 칸을 먼저 보여주고 원문 전환 버튼도
 * 갖고 있다. 같은 CVE 가 제품별로 여러 행일 수 있는데 설명은 같으므로 cve_id 로 한 번에 쓴다.
 *
 * lib/translate.ts(Gemini/Groq)가 아니라 lib/aiChat.ts 를 쓴다. NVD 설명은 공개
 * 텍스트라 어느 쪽이든 되지만, 화면에서 누르는 번역은 한 경로로 모아 둔다.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const cveId = decodeURIComponent(id).trim();
  if (!/^CVE-\d{4}-\d{4,}$/i.test(cveId)) {
    return NextResponse.json({ ok: false, message: "CVE 번호가 올바르지 않습니다." }, { status: 400 });
  }
  if (!(await hasOpenAi())) {
    return NextResponse.json(
      { ok: false, message: "LLM 연결이 없습니다. 설정 > LLM 연결에서 붙여주세요." },
      { status: 503 },
    );
  }

  const db = await openDb();
  try {
    const row = await db.get<{ summary: string; summary_ko: string }>(
      "SELECT summary, summary_ko FROM cves WHERE cve_id = ? LIMIT 1",
      [cveId],
    );
    if (row === undefined) {
      return NextResponse.json({ ok: false, message: "그 공지를 찾지 못했습니다." }, { status: 404 });
    }
    if (row.summary_ko.trim() !== "") {
      return NextResponse.json({ ok: true, already: true });
    }
    if (!needsTranslation(row.summary)) {
      return NextResponse.json({ ok: false, message: "번역할 영문 설명이 없습니다." }, { status: 400 });
    }

    const answer = await chat(TRANSLATE_SYSTEM_PROMPT, row.summary.slice(0, TRANSLATE_LIMIT));
    const text = cleanTranslation(answer);
    // 빈 번역을 저장하면 버튼이 사라진 채 원문만 남는다.
    if (text === "") {
      return NextResponse.json({ ok: false, message: "번역 결과가 비어 있습니다." }, { status: 502 });
    }
    await db.run("UPDATE cves SET summary_ko = ? WHERE cve_id = ?", [text, cveId]);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof OpenAiError || error instanceof Error
      ? error.message
      : String(error);
    return NextResponse.json({ ok: false, message }, { status: 502 });
  } finally {
    await db.close();
  }
}
