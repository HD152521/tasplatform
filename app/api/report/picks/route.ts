import { NextResponse } from "next/server";
import { isMonth } from "../../../../lib/instanceStore.ts";
import { isPickKind, savePicks } from "../../../../lib/reportPicks.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 보고서에 넣을 항목 선택을 저장한다. 그 달·그 종류의 선택을 통째로 바꾼다. */
export async function POST(request: Request) {
  let body: { month?: unknown; kind?: unknown; refs?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, message: "잘못된 요청입니다." }, { status: 400 });
  }

  if (!isMonth(body.month)) {
    return NextResponse.json(
      { ok: false, message: "대상 월이 올바르지 않습니다 (YYYY-MM)." },
      { status: 400 },
    );
  }
  if (!isPickKind(body.kind)) {
    return NextResponse.json(
      { ok: false, message: "선택 종류가 올바르지 않습니다." },
      { status: 400 },
    );
  }
  if (!Array.isArray(body.refs) || body.refs.some((r) => typeof r !== "string" || r === "")) {
    return NextResponse.json(
      { ok: false, message: "선택 목록이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  try {
    savePicks(body.month, body.kind, body.refs as string[]);
    return NextResponse.json({ ok: true, saved: body.refs.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, message: `저장 실패: ${message}` }, { status: 500 });
  }
}
