/**
 * SR 이 끝난 뒤 Jira 티켓에 남기는 **댓글 한 개** — 조립과 보내기.
 *
 * SR 등록 때 끊은 티켓(lib/srJiraTicketing.ts)에 "이렇게 끝났고 문서는 여기 있다" 를
 * 남긴다. 그래야 티켓만 보는 사람이 결과를 알 수 있다.
 *
 * ## 실패가 게시를 뒤집지 않는다
 *
 * 문서는 이미 Confluence 에 올라갔다. 댓글이 안 달렸다고 그 성공을 되돌리면, 다음
 * 회차가 같은 문서를 또 올린다. 그래서 던지지 않고 결과를 값으로 돌려준다.
 *
 * ## 두 번 달지 않는다
 *
 * `sr_jira_links.commented_at` 이 1차 자물쇠다 — 달고 나서 표시를 남긴다. 먼저 표시하면
 * 보내기가 실패했을 때 영영 안 달린다.
 *
 * 그런데 그 표시만으로는 모자라다. **보냈는지 모르는 실패**가 있다 — 타임아웃·5xx 는
 * 서버가 이미 받아 처리했는데 응답만 못 받은 경우일 수 있고, 보내기는 성공했는데 표시만
 * 실패할 수도 있다. 그 상태에서 다시 집으면 댓글이 두 번 달린다. 그래서 **다시 시도일
 * 때는 Jira 에 먼저 물어본다**(hasCommentWithLink).
 *
 * ## 본문에도 적는다
 *
 * 댓글만으로는 모자랐다. 등록 때 만든 티켓 **본문에는 문제 상황만** 있어서, 티켓을 여는
 * 사람은 "진행 중" 인 글을 읽고 댓글을 찾아 내려가야 했다. 그래서 끝난 뒤 본문 끝에
 * 조치 방향과 정리 문서 주소를 적는다(lib/jiraSolution.ts). 두 번 돌아도 그 자리만
 * 갈아 끼우고, 내용이 같으면 보내지 않는다.
 *
 * 순서는 **댓글 먼저**다. 본문 갱신은 읽고 쓰는 두 번 왕복이라 더 깨지기 쉬운데, 그것이
 * 댓글을 막으면 알림이 아예 안 간다. 본문 갱신이 실패하면 `commented_at` 을 남기지
 * 않아서 다음 회차가 다시 집고, 그때 댓글은 존재 확인으로 걸러진다.
 *
 * ## 실패하면 다시 집힌다
 *
 * 게시가 성공하면 그 SR 은 게시 대상 조회에서 빠진다. 그래서 그때 댓글이 실패하면
 * **영구히 누락됐다** — 다시 집는 조회가 없었다. 지금은 `findCommentable` 이
 * "게시됐고 아직 댓글 안 달린" 건을 따로 집는다(lib/autopublish.ts).
 */
import "server-only";
import { getSrJiraLink, markSrJiraCommented } from "./jiraLinkStore.ts";
import { srCommentBody } from "./jiraSrTicket.ts";
import { solutionNodes, solutionPatch } from "./jiraSolution.ts";
import {
  addSrComment,
  fetchIssueDescription,
  hasCommentWithLink,
  jiraSrConfig,
  updateIssueDescription,
  type JiraSrConfig,
} from "./jiraWrite.ts";
import { resultExcerpt } from "./srResultExcerpt.ts";
import type { Db } from "./db.ts";

/** 본문에 실을 조치 방향 길이. 댓글(400자)보다 넉넉히 준다 — 기록으로 남는 자리다. */
const SOLUTION_CHARS = 1_400;

/** 본문에 실을 줄 수. 댓글은 네 줄이지만 본문은 절 하나를 담는다. */
const SOLUTION_LINES = 16;

/** 본문 갱신 결과. `unchanged` 는 이미 같은 내용이 적혀 있어 보내지 않은 것이다. */
export type SolutionState = "ok" | "unchanged" | "off" | "failed";

/**
 * 티켓 본문 끝에 조치 방향과 정리 문서 주소를 적는다. **던지지 않는다.**
 *
 * 읽고 나서 쓴다 — 본문을 통째로 갈아 끼우는 API 라, 읽지 않고 쓰면 등록 때 적어 둔
 * 문제 상황이 사라진다.
 */
async function writeSolution(
  config: JiraSrConfig,
  issueKey: string,
  input: { summary: string; pageUrl: string },
): Promise<{ state: SolutionState; message: string }> {
  const nodes = solutionNodes({
    result: resultExcerpt(input.summary, SOLUTION_CHARS, SOLUTION_LINES),
    pageUrl: input.pageUrl,
  });
  if (nodes.length === 0) return { state: "off", message: "적을 것이 없습니다." };

  try {
    const current = await fetchIssueDescription(config, issueKey);
    const next = solutionPatch(current, nodes);
    // 같은 내용이 이미 적혀 있다. 보내면 티켓 이력에 같은 수정만 쌓인다.
    if (next === null) return { state: "unchanged", message: "" };
    await updateIssueDescription(config, issueKey, next);
    return { state: "ok", message: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[jira] ${issueKey} 본문에 조치 방향을 적지 못했습니다:`, error);
    return { state: "failed", message };
  }
}

export type CommentOutcome =
  /** 기능이 꺼졌거나 티켓이 없다. 고장이 아니다. */
  | { readonly state: "skipped"; readonly why: string }
  /**
   * 달았다. `marked: false` 면 달기는 했는데 표시를 못 남겼다 — 다음에 또 집힌다.
   * `solution` 은 티켓 **본문** 갱신이 어떻게 됐는지다(lib/jiraSolution.ts).
   */
  | {
      readonly state: "ok";
      readonly issueKey: string;
      readonly marked: boolean;
      readonly solution: SolutionState;
    }
  | { readonly state: "failed"; readonly issueKey: string; readonly message: string };

/**
 * 게시 직후 티켓에 **결과를 남긴다** — 댓글 하나와 본문 끝의 조치 방향.
 * **던지지 않는다.**
 *
 * `summary` 는 방금 게시한 정리 문서의 본문이다. 여기서 결과 부분만 뽑아 쓴다 —
 * AI 를 다시 부르지 않는다. 댓글은 두세 줄이고, 본문에는 절 하나만큼 적는다.
 */
export async function commentPublished(
  db: Db,
  input: {
    requestId: number;
    caseLabel: string;
    summary: string;
    pageUrl: string;
    /**
     * 다시 시도인가. 참이면 보내기 전에 **이미 달렸는지 Jira 에 물어본다.**
     * 첫 시도에는 묻지 않는다 — 있을 수가 없고, 왕복 한 번이 아깝다.
     */
    retry?: boolean;
  },
): Promise<CommentOutcome> {
  const config = jiraSrConfig();
  if (config === null) return { state: "skipped", why: "jira_off" };

  let issueKey = "";
  try {
    const link = await getSrJiraLink(db, input.requestId);
    if (link === null || link.issueKey === "") {
      // 티켓이 없는 SR 이다. 자동 게시 대상은 티켓이 있는 것만이라 보통 오지 않지만,
      // 사람이 손으로 올린 뒤 이 함수를 부르는 길이 생길 수 있다. 고장이 아니다.
      return { state: "skipped", why: "no_ticket" };
    }
    if (link.commentedAt !== "") {
      // 이미 달았다. 조건으로 대상을 고르는 구조라 같은 건이 다시 집힐 수 있다.
      return { state: "skipped", why: "already_commented" };
    }
    issueKey = link.issueKey;

    /*
     * 다시 시도라면 댓글은 이미 달려 있을 수 있다(머리말). 그래도 **본문 갱신은 한다** —
     * 다시 집힌 이유가 바로 그쪽 실패일 수 있다. 같은 내용이면 보내지 않으므로
     * (solutionPatch) 헛걸음이 되지 않는다.
     */
    const alreadyCommented = input.retry === true
      && await hasCommentWithLink(config, issueKey, input.pageUrl);

    if (!alreadyCommented) {
      await addSrComment(config, issueKey, srCommentBody({
        caseLabel: input.caseLabel,
        result: resultExcerpt(input.summary),
        pageUrl: input.pageUrl,
      }));
    }

    // 본문 끝에 조치 방향과 문서 주소를 적는다. 댓글 뒤에 두는 이유는 머리말에 있다.
    const solution = await writeSolution(config, issueKey, {
      summary: input.summary,
      pageUrl: input.pageUrl,
    });

    /*
     * 본문 갱신이 실패하면 **표시를 남기지 않는다.** 그러면 다음 회차가 다시 집어
     * 본문만 다시 시도한다 — 댓글은 위 존재 확인이 걸러 두 번 달리지 않는다.
     */
    if (solution.state === "failed") {
      return { state: "failed", issueKey, message: `본문 갱신 실패: ${solution.message}` };
    }

    /*
     * **달고 나서** 표시한다. 먼저 표시하면 보내기가 실패했을 때 영영 안 달린다.
     *
     * 표시가 실패해도 댓글은 **이미 달렸다.** 그래서 실패로 뒤집지 않고 `marked: false`
     * 로 알린다 — 다음 회차가 다시 집지만, 그때는 위 존재 확인이 중복을 막는다.
     */
    try {
      await markSrJiraCommented(db, input.requestId);
    } catch (error) {
      console.error(`[jira] ${issueKey} 에 댓글은 달았지만 표시를 남기지 못했습니다:`, error);
      return { state: "ok", issueKey, marked: false, solution: solution.state };
    }

    /*
     * 한 일이 아무것도 없으면 "했다" 고 세지 않는다. 댓글이 이미 달려 있고 본문도 같아서
     * 보낼 것이 없던 경우다 — 그걸 ok 로 올리면 화면이 "결과를 남겼습니다 1건" 이라고
     * 말하고, 매번 열리는 화면이라 그 줄을 아무도 안 보게 된다.
     */
    if (alreadyCommented && solution.state !== "ok") {
      return { state: "skipped", why: "already_commented" };
    }
    return { state: "ok", issueKey, marked: true, solution: solution.state };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[jira] 댓글 실패 ${issueKey || input.caseLabel} (게시 자체는 성공):`, error);
    return { state: "failed", issueKey, message };
  }
}
