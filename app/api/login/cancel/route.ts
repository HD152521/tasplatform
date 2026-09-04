import { NextResponse } from "next/server";
import { cancelLogin } from "../../../../lib/loginFlow.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { flowId?: unknown };
    if (typeof body.flowId === "string") await cancelLogin(body.flowId);
  } catch {
    // 정리 요청이라 실패해도 조용히 넘어간다. TTL 이 결국 정리한다.
  }
  return NextResponse.json({ ok: true });
}
