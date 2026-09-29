import { NextResponse } from "next/server";
import { openDb } from "../../../lib/db.ts";
import { parseCollectKind, type CollectKind } from "../../../lib/collectKind.ts";
import {
  collectOutcome, isCollectHandled, pendingCollectRequest, requestCollect,
} from "../../../lib/collectRequest.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 수집 한 회차를 지금 돌려 달라고 요청한다.
 *
 * 여기서 수집을 돌리지는 **않는다.** 웹에는 Playwright 가 없고, 수집은 수집기(worker)가
 * 도는 기계에서만 된다. 그래서 DB 에 요청만 남기고, worker 가 자는 동안 그것을 보고
 * 즉시 한 회차를 돌린다(collector/worker.ts). 화면은 GET 으로 진행 상태를 따라간다.
 *
 * 진행 판정에 **시각을 쓰지 않는다.** 웹과 수집기는 다른 기계라 시계가 어긋날 수 있고,
 * 같은 밀리초에 일이 몰리면 비교가 뒤집힌다(lib/collectRequest.ts 머리말 참고).
 * 대신 요청 번호(seq)와 회차 번호(run_id)로 본다 — 둘 다 단조 증가한다.
 *
 * ## 종류(kind)
 *
 * `?kind=cases|cves|kb`. **없으면 cases 다** — 진행중 케이스 화면이 이미 배포돼 종류를
 * 보내지 않는 채로 돌고 있고, 그 호출이 그대로 동작해야 한다. 모르는 이름은 400 으로
 * 거절한다(lib/collectKind.ts 참고).
 *
 * 끝났는지 보는 방법이 종류마다 다르다. 케이스 수집은 runs 에 회차를 남기므로 그 행을
 * 보고 "새 답변 N건" 까지 말할 수 있다. 보안 공지·기술 문서 수집기는 runs 에 아무것도
 * 남기지 않으므로(표준출력에만 적는다) worker 가 찍어 주는 완료 표시를 본다.
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

const RUN_COLUMNS =
  "run_id, started_at, finished_at, status, cases_seen, cases_changed, new_threads, error";

/** 종류를 읽는다. 모르는 이름이면 400 응답을, 아니면 종류를 돌려준다. */
function readKind(request: Request): { kind: CollectKind } | { error: NextResponse } {
  const raw = new URL(request.url).searchParams.get("kind");
  const kind = parseCollectKind(raw);
  if (kind === null) {
    return {
      error: NextResponse.json(
        { ok: false, message: `알 수 없는 수집 종류입니다: ${raw ?? ""}` },
        { status: 400 },
      ),
    };
  }
  return { kind };
}

export async function POST(request: Request) {
  const parsed = readKind(request);
  if ("error" in parsed) return parsed.error;
  const { kind } = parsed;

  try {
    const db = await openDb();
    try {
      const created = await requestCollect(db, kind);
      // 이 시점의 마지막 회차 번호. 이후 "이보다 큰 회차" 만 내 요청의 결과로 본다.
      // 케이스만 runs 를 쓰므로 다른 종류에서는 읽지 않는다.
      const latest = kind === "cases"
        ? await db.get<{ run_id: number }>("SELECT run_id FROM runs ORDER BY run_id DESC LIMIT 1")
        : undefined;
      return NextResponse.json({
        ok: true,
        kind,
        seq: created.seq,
        at: created.at,
        afterRunId: latest?.run_id ?? 0,
      });
    } finally {
      await db.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}

/**
 * 요청이 어디까지 갔는지 알려준다. `seq`·`after` 는 POST 가 돌려준 값이다.
 *
 * 상태를 넷으로 나눈다 — 사람이 기다려도 되는지, 끝났는지, 아니면 수집기가 아예
 * 안 도는지가 갈린다. 마지막 경우를 "대기 중" 으로 보여주면 영원히 기다리게 된다.
 *
 *   queued   요청은 남았지만 수집기가 아직 집어가지 않았다
 *   running  집어갔고, 회차가 아직 안 끝났다
 *   done     끝났다 — 결과를 함께 준다
 *   idle     seq 가 없을 때(단순 조회)
 */
export async function GET(request: Request) {
  const parsed = readKind(request);
  if ("error" in parsed) return parsed.error;
  const { kind } = parsed;

  const params = new URL(request.url).searchParams;
  const seq = Number(params.get("seq") ?? "");
  const after = Number(params.get("after") ?? "");

  try {
    const db = await openDb();
    try {
      if (!Number.isSafeInteger(seq) || seq <= 0) {
        const pending = await pendingCollectRequest(db, kind);
        const run = kind === "cases"
          ? await db.get<RunRow>(`SELECT ${RUN_COLUMNS} FROM runs ORDER BY run_id DESC LIMIT 1`)
          : undefined;
        return NextResponse.json({
          ok: true, kind, state: "idle", pending: pending !== null, run: run ?? null,
        });
      }

      if (!(await isCollectHandled(db, kind, seq))) {
        return NextResponse.json({ ok: true, kind, state: "queued", run: null });
      }

      // 보안 공지·기술 문서: runs 에 흔적이 없으니 worker 의 완료 표시만 본다.
      // 실패한 회차를 "완료" 라고 말하지 않도록 성공 여부도 함께 넘긴다.
      if (kind !== "cases") {
        const outcome = await collectOutcome(db, kind);
        if (outcome.seq < seq) {
          return NextResponse.json({ ok: true, kind, state: "running", run: null });
        }
        return NextResponse.json({
          ok: true, kind, state: "done", run: null, succeeded: outcome.ok,
        });
      }

      // 집어간 뒤다. 내 요청 이후에 시작된 회차만 본다 — 그 앞의 회차 결과를 내 것으로
      // 보여주면, 방금 올린 답변이 없는 화면을 "완료" 라고 말하게 된다.
      const baseline = Number.isSafeInteger(after) && after > 0 ? after : 0;
      const run = await db.get<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM runs WHERE run_id > ? ORDER BY run_id DESC LIMIT 1`,
        [baseline],
      );
      // 집어갔지만 아직 회차 행이 없다 — 자식 프로세스가 뜨는 중이다.
      if (run === undefined) {
        return NextResponse.json({ ok: true, kind, state: "running", run: null });
      }
      return NextResponse.json({
        ok: true,
        kind,
        state: run.finished_at === null ? "running" : "done",
        run,
      });
    } finally {
      await db.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}
