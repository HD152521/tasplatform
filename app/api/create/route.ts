import { NextResponse } from "next/server";
import { PRIORITIES, createCase } from "../../../lib/createCase.ts";
import {
  SessionExpiredError, SessionMissingError,
  ensureSessionValid, openSavedSession, persistSession,
} from "../../../collector/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: {
    subject?: unknown; content?: unknown; priorityId?: unknown;
    productId?: unknown; componentId?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: "잘못된 요청입니다." }, { status: 400 });
  }

  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const content = typeof body.content === "string" ? body.content.trim() : "";
  const priorityId = Number(body.priorityId);

  if (subject === "" || content === "") {
    return NextResponse.json({ ok: false, message: "제목과 내용을 입력하세요." }, { status: 400 });
  }
  if (!PRIORITIES.some((p) => p.id === priorityId)) {
    return NextResponse.json({ ok: false, message: "우선순위가 올바르지 않습니다." }, { status: 400 });
  }

  let session: Awaited<ReturnType<typeof openSavedSession>> | null = null;
  try {
    session = await openSavedSession();
    await ensureSessionValid(session.context);
    const productId = Number(body.productId);
    const componentId = Number(body.componentId);
    const result = await createCase(session.context, {
      subject, content, priorityId,
      productId: Number.isFinite(productId) ? productId : undefined,
      componentId: Number.isFinite(componentId) ? componentId : undefined,
    });
    await persistSession(session.context);
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  } catch (error) {
    // 세션 문제만 401 로 돌려준다. 그 외(코드 버그 등)를 401 로 뭉뚱그리면
    // 화면에 "로그인하세요"가 떠서 진짜 원인을 못 찾는다.
    const isSession = error instanceof SessionExpiredError || error instanceof SessionMissingError;
    const message = error instanceof Error ? error.message : String(error);
    if (!isSession) console.error("[api/create]", error);
    return NextResponse.json(
      { ok: false, code: isSession ? "session" : "failed", message },
      { status: isSession ? 401 : 500 },
    );
  } finally {
    await session?.close();
  }
}
