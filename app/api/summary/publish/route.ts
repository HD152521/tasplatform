/**
 * 요약(Confluence 문서)을 실제 Confluence 에 올린다.
 * 사람이 화면에서 "Confluence 에 올리기" 를 눌렀을 때만 호출된다.
 */
import { NextResponse } from "next/server";
import { publishSummaryToConfluence } from "../../../../lib/confluencePublish.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  let body: { requestId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "잘못된 요청입니다." }, { status: 400 });
  }

  const requestId = Number(body.requestId);
  if (!Number.isFinite(requestId)) {
    return NextResponse.json({ ok: false, error: "케이스 번호가 올바르지 않습니다." }, { status: 400 });
  }

  try {
    const result = await publishSummaryToConfluence(requestId);
    return NextResponse.json({ ok: true, url: result.url, created: result.created });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
