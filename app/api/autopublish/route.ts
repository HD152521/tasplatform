import { NextResponse } from "next/server";
import {
  MAX_PER_RUN,
  bumpCommentTries,
  bumpPublishTries,
  claimRun,
  countCommentGivenUp,
  countGivenUp,
  findCommentable,
  findPublishable,
  readSince,
  refundPublishTries,
  releaseRun,
} from "../../../lib/autopublish.ts";
import { openDb } from "../../../lib/db.ts";
import { publishSummaryToConfluence } from "../../../lib/confluencePublish.ts";
import { getSummary } from "../../../lib/summary.ts";
import { commentPublished } from "../../../lib/srJiraComment.ts";
import { AtlassianError, hasAtlassian } from "../../../lib/atlassian.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * 한 회차에 쓸 시간 예산.
 *
 * 요약이 없으면 건당 60초(collector/prewarm.ts), 게시는 Confluence 호출 4~5번이고 각
 * 45초 타임아웃이다. 느린 날에는 한 건이 수백 초가 될 수 있다. 라우터가 끊으면 응답이
 * 사라져 화면은 아무것도 모른다. 그래서 **새 건을 시작하기 전에** 남은 시간을 본다.
 *
 * 끊겨도 안전하다 — 자물쇠는 상하면 풀리고, 횟수는 올리기 전에 세므로 무한 재시도가
 * 되지 않는다.
 */
const BUDGET_MS = 150_000;

/**
 * SR 이 끝났으면 정리 문서를 Confluence 에 **자동으로** 올린다.
 *
 * ## 왜 웹이 하나
 *
 * 게시에 필요한 모듈이 `server-only` 라 수집기 프로세스에서 import 되지 않는다
 * (`lib/confluencePublish.ts` → `lib/atlassian.ts`). 그래서 여기서 한다.
 *
 * ## 누가 부르나
 *
 * 실시간일 필요가 없다. 완료 목록 화면이 열릴 때 한 번 부른다(app/closed 의
 * AutoPublishKick). 바깥에서 들어오는 길도, 닿는지 확인할 것도 없다.
 *
 * 서버에서 불을 질러 놓고 응답을 끝내는 방식은 쓰지 않는다 — TAS 가 그 작업을 죽일 수
 * 있다. 그래서 **클라이언트가 부르고 응답을 기다린다.**
 *
 * ## 겹쳐 돌면 어떻게 되나
 *
 * **자물쇠를 먼저 잡고, 그다음에 대상을 고른다.** 순서가 반대면 두 호출이 같은 목록을
 * 들고 차례로 돌아, 이미 올라간 문서를 또 갱신하고 시도 횟수를 두 번 먹는다. "올렸다"
 * 표시는 **고를 때만** 보는 값이라 자물쇠 역할을 하지 못한다.
 *
 * ## 게시 뒤에는 Jira 티켓에 댓글을 남긴다
 *
 * SR 등록 때 끊은 티켓에 "이렇게 끝났고 문서는 여기 있다" 를 남긴다. 그 댓글이 실패해도
 * **게시 성공은 뒤집지 않는다** — 문서는 이미 올라갔고, 뒤집으면 다음 회차가 같은 문서를
 * 또 올린다. AI 를 다시 부르지도 않는다(요약에서 결과 부분만 뽑아 쓴다).
 *
 * ## 요약은 보통 이미 만들어져 있다
 *
 * 수집기가 새로 종료된 건의 요약을 미리 만들어 둔다(collector/prewarm.ts). 그래서 이
 * 라우트는 대개 **게시만** 하고 빨리 끝난다. 없으면 여기서 만든다 — 그때는 느리다.
 *
 * ## dry run
 *
 * `?dryRun=1` 또는 GET 은 **아무것도 올리지 않고 건수만** 돌려준다. 기준 시각도 박지
 * 않는다 — 박는 시각이 곧 "이때부터 대상" 이라, 켜기 전에 세어 보다가 박히면 그 사이에
 * 생성된 SR 이 전부 대상에 들어온다.
 *
 * 켜기 전에 이것으로 숫자를 본다. 0 이나 1 이 아니면 켜지 않는다.
 */
export async function GET(request: Request): Promise<Response> {
  return await handle(request, true);
}

export async function POST(request: Request): Promise<Response> {
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  return await handle(request, dryRun);
}

/**
 * 판 전체의 문제인가.
 *
 * 토큰 만료·권한·설정 누락·서버 장애는 **그 SR 의 문제가 아니다.** 그런 실패에 시도
 * 횟수를 먹이면 고친 뒤에도 영영 집히지 않는다(상한에 닿아서). 그래서 횟수를 되돌리고
 * 회차를 멈춘다 — 남은 건에 같은 실패를 되풀이할 이유도 없다.
 */
function isEnvironmentFailure(error: unknown): boolean {
  if (error instanceof AtlassianError) {
    return error.status === 401 || error.status === 403 || error.status >= 500;
  }
  // 설정 누락은 평범한 Error 로 던진다(lib/confluencePublish.ts).
  const message = error instanceof Error ? error.message : String(error);
  return /설정|ATLASSIAN|CONFLUENCE_SPACE|CONFLUENCE_PARENT_ID/.test(message);
}

async function handle(request: Request, dryRun: boolean): Promise<Response> {
  if (!hasAtlassian()) {
    // 설정이 없으면 기능이 없는 셈이다. 조용히 0 으로 돌아간다 — 화면이 매번 부르는
    // 자리라 오류를 띄우면 쓸데없이 빨간 줄이 생긴다.
    return NextResponse.json({ ok: true, state: "off", published: 0, pending: 0 });
  }

  const db = await openDb();
  try {
    const { sinceMs, first, initialized } = await readSince(db, { stamp: !dryRun });

    if (dryRun) {
      if (!initialized) {
        return NextResponse.json({
          ok: true,
          state: "not_initialized",
          pending: 0,
          note: "아직 기준 시각이 없습니다. POST 로 한 번 돌리면 그때가 기준이 되고, 그 뒤에 생성된 SR 만 대상이 됩니다.",
        });
      }
      const targets = await findPublishable(db, sinceMs, 1000);
      return NextResponse.json({
        ok: true,
        state: "dry_run",
        pending: targets.length,
        // 상한에 닿아 **포기한** 건수. 이게 보이지 않으면 자동 게시가 조용히 멈춘 것을
        // 아무도 모른다.
        givenUp: await countGivenUp(db, sinceMs),
        // 게시는 됐는데 **댓글만** 못 단 건. 이게 보이지 않으면 결과가 영구히 누락된
        // 것을 아무도 모른다.
        commentPending: (await findCommentable(db, sinceMs, 1000)).length,
        commentGivenUp: await countCommentGivenUp(db, sinceMs),
        cases: targets.map((t) => ({ caseLabel: t.caseLabel, issueKey: t.issueKey, tries: t.tries })),
      });
    }

    if (first) {
      // 처음 돌았다. 지금 이미 종료돼 있던 SR 들은 **대상이 아니다.**
      console.log("[autopublish] 기준 시각을 지금으로 박았습니다. 이전에 올라온 건은 건너뜁니다.");
      return NextResponse.json({ ok: true, state: "initialized", published: 0, pending: 0 });
    }

    // **자물쇠를 먼저.** 대상을 고른 뒤에 잡으면 두 호출이 같은 목록으로 돈다(머리말).
    if (!(await claimRun(db))) {
      return NextResponse.json({ ok: true, state: "busy", published: 0, pending: 0 });
    }

    const done: string[] = [];
    const failed: Array<{ caseLabel: string; message: string }> = [];
    /** 티켓에 결과를 남긴 건. 게시와 **따로** 센다 — 둘 중 하나만 실패할 수 있다. */
    const commented: string[] = [];
    const commentFailed: Array<{ caseLabel: string; message: string }> = [];
    let stoppedBy: "budget" | "environment" | null = null;
    let left = 0;

    try {
      const deadline = Date.now() + BUDGET_MS;
      const targets = await findPublishable(db, sinceMs);
      left = targets.length;

      for (const target of targets) {
        if (Date.now() > deadline) {
          // 남은 건은 다음 회차가 집는다. 조건으로 고르는 구조라 잊히지 않는다.
          stoppedBy = "budget";
          break;
        }
        // **올리기 전에** 횟수를 센다. 도중에 죽어도 횟수가 남아야 영구 실패를 끊는다.
        await bumpPublishTries(db, target.requestId);
        left -= 1;
        try {
          // 요약이 없으면 만든다. force 를 주지 않는다 — 사람이 쓴 초안을 덮으면 안 된다.
          const summary = await getSummary(target.requestId, "confluence", false);
          if ("error" in summary) {
            failed.push({ caseLabel: target.caseLabel, message: summary.error });
            continue;
          }
          const result = await publishSummaryToConfluence(target.requestId);
          done.push(`${target.caseLabel} → ${result.url}`);
          console.log(`[autopublish] 올림 ${target.caseLabel} ${result.created ? "(새 문서)" : "(갱신)"}`);

          /*
           * 티켓에 결과를 남긴다. **게시 성공을 뒤집지 않는다** — 던지지 않는 함수이고,
           * 실패하면 값으로 돌아온다. 여기서 던지게 두면 이미 올라간 문서가 "실패" 로
           * 기록되고 다음 회차가 또 올린다.
           */
          const comment = await commentPublished(db, {
            requestId: target.requestId,
            caseLabel: target.caseLabel,
            summary: summary.content,
            pageUrl: result.url,
          });
          if (comment.state === "failed") {
            commentFailed.push({ caseLabel: target.caseLabel, message: comment.message });
          } else if (comment.state === "ok") {
            commented.push(`${target.caseLabel} → ${comment.issueKey}`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failed.push({ caseLabel: target.caseLabel, message });
          console.error(`[autopublish] 실패 ${target.caseLabel} — ${message}`);

          if (isEnvironmentFailure(error)) {
            // 환경 문제다. 이 SR 의 횟수를 되돌리고 회차를 멈춘다 — 남은 건에 같은
            // 실패를 되풀이하면 대기 중인 전부가 상한에 닿아 영영 빠진다.
            await refundPublishTries(db, target.requestId);
            left += 1;
            stoppedBy = "environment";
            break;
          }
        }
      }
      /*
       * ## 밀린 댓글을 따라잡는다
       *
       * 게시가 성공하면 그 SR 은 게시 대상 조회에서 빠진다. 그래서 그때 댓글이 실패하면
       * **영구히 누락됐다** — 다시 집는 조회가 없었다. 알림도 그 순간 화면을 연 사람에게만
       * 보이고 새로고침하면 사라졌다.
       *
       * 그래서 "게시됐고 아직 댓글 안 달린" 건을 따로 집어 다시 보낸다. 다시 보내기
       * 전에는 Jira 에 이미 달렸는지 물어본다 — 보냈는지 모르는 실패가 있어서다
       * (lib/srJiraComment.ts 머리말).
       */
      const behind = await findCommentable(db, sinceMs);
      for (const target of behind) {
        if (Date.now() > deadline) {
          stoppedBy = stoppedBy ?? "budget";
          break;
        }
        await bumpCommentTries(db, target.requestId);
        const outcome = await commentPublished(db, {
          requestId: target.requestId,
          caseLabel: target.caseLabel,
          summary: target.summary,
          pageUrl: target.pageUrl,
          retry: true,
        });
        if (outcome.state === "failed") {
          // 화면에는 짧게만 흘린다. Jira 응답 본문이 400자까지 실려 오는데(AtlassianError),
          // 그걸 그대로 보여 주면 읽히지도 않고 담을 이유도 없다. 원문은 서버 로그에 있다.
          commentFailed.push({ caseLabel: target.caseLabel, message: outcome.message.slice(0, 160) });
        } else if (outcome.state === "ok") {
          commented.push(`${target.caseLabel} → ${outcome.issueKey}`);
        }
      }
    } finally {
      // **반드시 놓는다.** 안 놓으면 자물쇠가 상할 때까지 아무도 못 돈다.
      await releaseRun(db);
    }

    return NextResponse.json({
      ok: true,
      state: "ran",
      published: done.length,
      failed: failed.length,
      pending: Math.max(0, left),
      stoppedBy,
      limit: MAX_PER_RUN,
      commented: commented.length,
      commentFailed: commentFailed.length,
      details: { done, failed, commented, commentFailed },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[autopublish] 회차 전체 실패:", error);
    return NextResponse.json({ ok: false, message }, { status: 500 });
  } finally {
    await db.close();
  }
}
