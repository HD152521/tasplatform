import { NextResponse } from "next/server";
import { openDb } from "../../../lib/db.ts";
import { pendingCollectRequest, requestCollect } from "../../../lib/collectRequest.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 수집 한 회차를 지금 돌려 달라고 요청한다.
 *
 * 여기서 수집을 돌리지는 **않는다.** 웹에는 Playwright 가 없고, 수집은 수집기(worker)가
 * 도는 기계에서만 된다. 그래서 DB 에 요청만 남기고, worker 가 자는 동안 그것을 보고
 * 즉시 한 회차를 돌린다(collector/worker.ts). 화면은 GET 으로 진행 상태를 따라간다.
 */

interface RunRow {
  run_id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  cases_seen: number;
  cases_changed: number;
  new_threads: number;
  error: string | null;
}

async function latestRun(): Promise<RunRow | undefined> {
  const db = await openDb();
  try {
    return await db.get<RunRow>(
      `SELECT run_id, started_at, finished_at, status, cases_seen, cases_changed, new_threads, error
         FROM runs ORDER BY run_id DESC LIMIT 1`,
    );
  } finally {
    await db.close();
  }
}

export async function POST() {
  try {
    const db = await openDb();
    let requestedAt: string;
    try {
      requestedAt = await requestCollect(db);
    } finally {
      await db.close();
    }
    return NextResponse.json({ ok: true, requestedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}

/**
 * 요청이 어디까지 갔는지 알려준다. `since` 는 POST 가 돌려준 requestedAt 이다.
 *
 * 상태를 넷으로 나눈다 — 사람이 기다려도 되는지, 끝났는지, 아니면 수집기가 아예
 * 안 도는지가 갈린다. 마지막 경우를 "대기 중" 으로 보여주면 영원히 기다리게 된다.
 *
 *   queued   요청은 남았지만 수집기가 아직 집어가지 않았다
 *   running  그 요청 뒤에 시작된 회차가 아직 안 끝났다
 *   done     끝났다 — 결과를 함께 준다
 *   idle     since 가 없을 때(단순 조회)
 */
export async function GET(request: Request) {
  const since = new URL(request.url).searchParams.get("since") ?? "";
  try {
    const db = await openDb();
    let pending: string | null;
    try {
      pending = await pendingCollectRequest(db);
    } finally {
      await db.close();
    }
    const run = await latestRun();

    if (since === "") {
      return NextResponse.json({ ok: true, state: "idle", pending: pending !== null, run: run ?? null });
    }

    // 그 요청 뒤에 시작된 회차가 있는가. 없으면 아직 집어가지 않은 것이다.
    const startedAfter = run !== undefined && run.started_at >= since;
    if (!startedAfter) {
      return NextResponse.json({ ok: true, state: "queued", run: run ?? null });
    }
    if (run.finished_at === null) {
      return NextResponse.json({ ok: true, state: "running", run });
    }
    return NextResponse.json({ ok: true, state: "done", run });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}
