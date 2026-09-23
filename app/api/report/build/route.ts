import { NextResponse } from "next/server";
import { isMonth } from "../../../../lib/instanceStore.ts";
import { ReportBuildError, buildMonthlyReport } from "../../../../lib/pptx.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// SR 건수만큼 AI 를 부르므로 오래 걸린다.
export const maxDuration = 900;

/**
 * ASCII 대체 파일명. 한글이 못 지나가는 경로에서도 확장자는 살아남아야 한다.
 * month 는 이미 isMonth 로 검사한 'YYYY-MM' 이라 따옴표나 비ASCII 가 섞일 수 없다.
 */
function asciiName(month: string): string {
  return `${month}_monthly_report.pptx`;
}

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
        // 두 가지를 함께 준다.
        //   filename   — 순수 ASCII 대체 이름
        //   filename*  — 한글이 살아 있는 진짜 이름 (RFC 5987)
        // filename* 만 주면, 그 헤더를 흘리거나 못 읽는 경로(프록시·게이트웨이·다운로드
        // 관리자)에서 브라우저가 주소 마지막 조각인 "build" 로 저장해 버린다. 확장자가
        // 없으니 Windows 가 "사용할 수 없는 파일" 이라고 한다. 파일 자체는 멀쩡한데도.
        "Content-Disposition":
          `attachment; filename="${asciiName(month)}"; `
          + `filename*=UTF-8''${encodeURIComponent(built.fileName)}`,
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
