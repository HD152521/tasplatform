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
 * ## 실패하면 다시 집힌다
 *
 * 게시가 성공하면 그 SR 은 게시 대상 조회에서 빠진다. 그래서 그때 댓글이 실패하면
 * **영구히 누락됐다** — 다시 집는 조회가 없었다. 지금은 `findCommentable` 이
 * "게시됐고 아직 댓글 안 달린" 건을 따로 집는다(lib/autopublish.ts).
 */
import "server-only";
import { getSrJiraLink, markSrJiraCommented } from "./jiraLinkStore.ts";
import { srCommentBody } from "./jiraSrTicket.ts";
import { addSrComment, hasCommentWithLink, jiraSrConfig } from "./jiraWrite.ts";
import { resultExcerpt } from "./srResultExcerpt.ts";
import type { Db } from "./db.ts";

export type CommentOutcome =
  /** 기능이 꺼졌거나 티켓이 없다. 고장이 아니다. */
  | { readonly state: "skipped"; readonly why: string }
  /** 달았다. `marked: false` 면 달기는 했는데 표시를 못 남겼다 — 다음에 또 집힌다. */
  | { readonly state: "ok"; readonly issueKey: string; readonly marked: boolean }
  | { readonly state: "failed"; readonly issueKey: string; readonly message: string };

/**
 * 게시 직후 댓글을 남긴다. **던지지 않는다.**
 *
 * `summary` 는 방금 게시한 정리 문서의 본문이다. 여기서 결과 부분만 뽑아 쓴다 —
 * AI 를 다시 부르지 않는다.
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

    // 다시 시도라면 이미 달려 있을 수 있다(머리말). 있으면 표시만 남기고 끝낸다.
    if (input.retry === true && await hasCommentWithLink(config, issueKey, input.pageUrl)) {
      await markSrJiraCommented(db, input.requestId);
      return { state: "skipped", why: "already_commented" };
    }

    await addSrComment(config, issueKey, srCommentBody({
      caseLabel: input.caseLabel,
      result: resultExcerpt(input.summary),
      pageUrl: input.pageUrl,
    }));

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
      return { state: "ok", issueKey, marked: false };
    }
    return { state: "ok", issueKey, marked: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[jira] 댓글 실패 ${issueKey || input.caseLabel} (게시 자체는 성공):`, error);
    return { state: "failed", issueKey, message };
  }
}
