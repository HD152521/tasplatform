import { NextResponse } from "next/server";
import { getSummary, isSummaryKind } from "../../../lib/summary.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// AI 호출이 오래 걸린다. 기본 타임아웃으로는 잘린다.
export const maxDuration = 300;

export async function POST(request: Request) {
  let body: { requestId?: unknown; kind?: unknown; force?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 });
  }

  const requestId = Number(body.requestId);
  if (!Number.isFinite(requestId)) {
    return NextResponse.json({ error: "케이스 번호가 올바르지 않습니다." }, { status: 400 });
  }
  if (!isSummaryKind(body.kind)) {
    return NextResponse.json({ error: "정리 형식이 올바르지 않습니다." }, { status: 400 });
  }

  try {
    const result = await getSummary(requestId, body.kind, body.force === true);
    if ("error" in result) return NextResponse.json(result, { status: 404 });
    return NextResponse.json(result);
  } catch (error) {
    // 생성 실패를 빈 문서로 돌려주지 않는다.
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
