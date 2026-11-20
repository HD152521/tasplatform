/**
 * Jira → 캘린더 가져오기(백필).
 *
 * **사람이 눌러야 돈다.** 화면 진입에 매달지 않는 이유: 몇백 건을 훑는 조회라
 * 느리고, 자동으로 돌면 "왜 과거 일정이 갑자기 생겼나" 를 아무도 설명할 수 없다.
 * 가져오기는 사람이 한 번 누르고 결과를 읽는 동작이어야 한다.
 *
 * 멱등하다 — 여러 번 눌러도 `jira_key` 로 맞춰 갱신만 한다.
 */
import { NextResponse } from "next/server";
import { actorOf, userFromRequestWith } from "../../../../lib/appAuth.ts";
import { openDb, recordAudit } from "../../../../lib/db.ts";
import { importFrom, importFromJira } from "../../../../lib/jiraImport.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // 본문 없이 부르면 기본 시작점(이번 달 1일)을 쓴다.
  }

  const db = await openDb();
  try {
    const me = await userFromRequestWith(db, request);
    if (me === null) {
      return NextResponse.json({ ok: false, message: "로그인이 필요합니다." }, { status: 401 });
    }
    if (me.teamId === "") {
      return NextResponse.json({ ok: false, message: "속한 팀이 없습니다." }, { status: 400 });
    }

    const from = typeof body.from === "string" ? body.from : undefined;
    const result = await importFromJira(db, me.teamId, { from, actor: actorOf(me) });

    await recordAudit(db, {
      actor: actorOf(me), teamId: me.teamId, action: "calendar_import_jira", requestId: null,
      result: "ok",
      detail: `from=${result.from} scanned=${result.scanned} created=${result.created} updated=${result.updated}`,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  } finally {
    await db.close();
  }
}

/** 기본 시작점이 언제인지 화면에 알려 준다. */
export function GET() {
  return NextResponse.json({ ok: true, from: importFrom() });
}
