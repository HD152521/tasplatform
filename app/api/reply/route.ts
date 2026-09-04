import { NextResponse } from "next/server";
import { isClosedStatus, getCase } from "../../../lib/queries.ts";
import { postReply } from "../../../lib/reply.ts";
import { ensureSessionValid, openSavedSession, persistSession } from "../../../collector/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { requestId?: unknown; text?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: "잘못된 요청입니다." }, { status: 400 });
  }

  const requestId = Number(body.requestId);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!Number.isFinite(requestId) || text === "") {
    return NextResponse.json({ ok: false, message: "내용을 입력하세요." }, { status: 400 });
  }

  // 종료된 케이스에는 보내지 않는다.
  const detail = getCase(requestId);
  if (detail === null) {
    return NextResponse.json({ ok: false, message: "케이스를 찾을 수 없습니다." }, { status: 404 });
  }
  if (isClosedStatus(detail.status)) {
    return NextResponse.json(
      { ok: false, message: "종료된 케이스에는 답변할 수 없습니다." },
      { status: 400 },
    );
  }

  let session: Awaited<ReturnType<typeof openSavedSession>> | null = null;
  try {
    session = await openSavedSession();
    await ensureSessionValid(session.context);
    const result = await postReply(session.context, requestId, text);
    await persistSession(session.context);
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, code: "session", message },
      { status: 401 },
    );
  } finally {
    await session?.close();
  }
}
