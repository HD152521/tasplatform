import { NextResponse } from "next/server";
import { getSummary, isSummaryKind } from "../../../lib/summary.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  const result = getSummary(requestId, body.kind, body.force === true);
  if ("error" in result) return NextResponse.json(result, { status: 404 });
  return NextResponse.json(result);
}
