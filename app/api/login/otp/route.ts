import { NextResponse } from "next/server";
import { submitOtp } from "../../../../lib/loginFlow.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { flowId?: unknown; code?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ status: "error", message: "잘못된 요청입니다." }, { status: 400 });
  }

  const flowId = typeof body.flowId === "string" ? body.flowId : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (flowId === "" || code === "") {
    return NextResponse.json(
      { status: "error", message: "인증 코드를 입력하세요." },
      { status: 400 },
    );
  }

  return NextResponse.json(await submitOtp(flowId, code));
}
