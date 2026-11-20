/**
 * 주간 자동 정리 — 읽기·생성.
 *
 * GET  `?week=YYYY-MM-DD`  그 주의 정리(없으면 null) + 최근 목록
 * POST `{ week, ruleOnly? }`  그 주의 정리를 만든다(덮어쓴다)
 *
 * 생성은 LLM 을 때릴 수 있어 **사람의 동작**으로 둔다. 다만 "지난 주 것이 아직
 * 없으면" 은 화면 진입이 한 번 깨운다(lib/weeklyDigest.ts autoBuildLastWeek).
 */
import { NextResponse } from "next/server";
import { actorOf, userFromRequestWith } from "../../../../lib/appAuth.ts";
import { openDb, recordAudit } from "../../../../lib/db.ts";
import {
  autoBuildLastWeek,
  buildWeeklyDigest,
  getWeeklyDigest,
  listWeeklyDigests,
  weekMondayOf,
} from "../../../../lib/weeklyDigest.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UNAUTHORIZED = { ok: false, message: "로그인이 필요합니다." };

function fail(error: unknown): NextResponse {
  return NextResponse.json(
    { ok: false, message: error instanceof Error ? error.message : String(error) },
    { status: 400 },
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const db = await openDb();
  try {
    const me = await userFromRequestWith(db, request);
    if (me === null) return NextResponse.json(UNAUTHORIZED, { status: 401 });
    if (me.teamId === "") return NextResponse.json({ ok: true, digest: null, recent: [] });

    const week = url.searchParams.get("week") ?? "";
    const today = url.searchParams.get("today") ?? "";

    // 지난 주 정리가 없으면 여기서 한 번 만든다. 주당 한 번만 돈다.
    if (today !== "") {
      await autoBuildLastWeek(db, me.teamId, today).catch(() => null);
    }

    return NextResponse.json({
      ok: true,
      digest: week === "" ? null : await getWeeklyDigest(db, me.teamId, week),
      recent: await listWeeklyDigests(db, me.teamId),
    });
  } catch (error) {
    return fail(error);
  } finally {
    await db.close();
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // 본문 없이 부르면 주를 알 수 없다 — 아래에서 걸린다.
  }

  const db = await openDb();
  try {
    const me = await userFromRequestWith(db, request);
    if (me === null) return NextResponse.json(UNAUTHORIZED, { status: 401 });
    if (me.teamId === "") {
      return NextResponse.json({ ok: false, message: "속한 팀이 없습니다." }, { status: 400 });
    }

    const week = typeof body.week === "string" ? body.week : "";
    if (week === "") {
      return NextResponse.json({ ok: false, message: "어느 주인지 알 수 없습니다." }, { status: 400 });
    }

    const digest = await buildWeeklyDigest(db, me.teamId, week, {
      actor: actorOf(me),
      ruleOnly: body.ruleOnly === true,
    });
    await recordAudit(db, {
      actor: actorOf(me), teamId: me.teamId, action: "weekly_digest", requestId: null,
      result: "ok", detail: `week=${weekMondayOf(week)} source=${digest.source}`,
    });

    return NextResponse.json({
      ok: true,
      digest,
      recent: await listWeeklyDigests(db, me.teamId),
    });
  } catch (error) {
    return fail(error);
  } finally {
    await db.close();
  }
}
