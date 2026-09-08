import { NextResponse } from "next/server";
import { SrReportError, getSrReport, hasSrReporter } from "../../../../lib/srReport.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// AI 호출이 오래 걸린다. 기본 타임아웃으로는 잘린다.
export const maxDuration = 300;

/** SR 상세 슬라이드용 보고서를 만든다(또는 저장분을 돌려준다). */
export async function POST(request: Request) {
  let body: { requestId?: unknown; force?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, message: "잘못된 요청입니다." }, { status: 400 });
  }

  const requestId = Number(body.requestId);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    return NextResponse.json(
      { ok: false, message: "케이스 번호가 올바르지 않습니다." },
      { status: 400 },
    );
  }
  if (!hasSrReporter()) {
    return NextResponse.json(
      { ok: false, message: ".env 에 OPENAI_API_KEY 가 필요합니다." },
      { status: 503 },
    );
  }

  try {
    const report = await getSrReport(requestId, body.force === true);
    return NextResponse.json({ ok: true, ...report });
  } catch (error) {
    // 생성 실패를 빈 보고서로 돌려주지 않는다.
    if (error instanceof SrReportError) {
      const status = error.status === 404 ? 404 : 502;
      return NextResponse.json({ ok: false, message: error.message }, { status });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, message }, { status: 502 });
  }
}
