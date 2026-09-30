/**
 * 사진 단계 건너뛰기 표시.
 *
 * 별도 라우트로 둔 이유: "아직 안 정했다" 와 "사진 없이 가기로 했다" 는 다른 사실이고,
 * 사진 한 장을 넣고 빼는 것과 섞이면 어느 쪽이 상태를 정했는지 알기 어려워진다.
 * 보고서를 만들 때 "사진 없이 만들까요?" 를 물을지가 이 값 하나로 갈린다.
 */
import { NextResponse } from "next/server";
import { isMonth } from "../../../../../lib/instanceStore.ts";
import { setPhotosSkipped } from "../../../../../lib/reportPhotos.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let body: { month?: unknown; skipped?: unknown };
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
  // true/false 만 받는다. 없는 값을 false 로 뭉개면 "되돌리기" 와 구분이 안 된다.
  if (typeof body.skipped !== "boolean") {
    return NextResponse.json(
      { ok: false, message: "건너뛰기 여부가 올바르지 않습니다." },
      { status: 400 },
    );
  }

  try {
    await setPhotosSkipped(body.month, body.skipped);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, message: `저장 실패: ${message}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, skipped: body.skipped });
}
