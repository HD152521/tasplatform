import { NextResponse } from "next/server";
import { isMonth } from "../../../../lib/instanceStore.ts";
import { ReportBuildError, buildMonthlyReport } from "../../../../lib/pptx.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// SR 건수만큼 AI 를 부르므로 오래 걸린다.
export const maxDuration = 900;

/** 완성된 정기점검 보고서 pptx 를 내려준다. */
export async function GET(request: Request) {
  const month = new URL(request.url).searchParams.get("month") ?? "";
  if (!isMonth(month)) {
    return NextResponse.json(
      { ok: false, message: "대상 월이 올바르지 않습니다 (YYYY-MM)." },
      { status: 400 },
    );
  }

  try {
    const built = await buildMonthlyReport(month);
    return new NextResponse(new Uint8Array(built.bytes), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "Content-Disposition":
          `attachment; filename*=UTF-8''${encodeURIComponent(built.fileName)}`,
        "X-Sr-Count": String(built.srCount),
        "X-Work-Count": String(built.workCount),
      },
    });
  } catch (error) {
    // 실패를 빈 파일로 돌려주지 않는다.
    const message = error instanceof ReportBuildError || error instanceof Error
      ? error.message
      : String(error);
    return NextResponse.json({ ok: false, message }, { status: 502 });
  }
}
