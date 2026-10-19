/**
 * SR 을 등록한 **뒤** Jira 티켓을 끊는 한 걸음.
 *
 * ## 왜 따로 두나
 *
 * 등록 라우트(app/api/create)는 이미 길다. 그리고 이 걸음은 **실패해도 등록을 뒤집지
 * 않아야** 하는데, 그 규칙을 라우트 안에 섞어 두면 다음에 누가 고치면서 throw 를
 * 되살린다. 그래서 "절대 던지지 않는 함수" 로 떼어낸다.
 *
 * ## 실패를 조용히 넘기지는 않는다
 *
 * 던지지 않는 것과 숨기는 것은 다르다. 실패하면 결과에 담아 돌려주고, 화면이 "티켓은
 * 만들지 못했습니다" 를 보여 준다. 감사 로그에도 남긴다. 티켓이 없으면 SR 이 끝난 뒤
 * 댓글을 달 곳이 없으므로, 사람이 알아야 손으로 만들 수 있다.
 */
import "server-only";
import { openDb } from "./db.ts";
import { saveSrJiraLink } from "./jiraLinkStore.ts";
import {
  DEFAULT_TRACK,
  koTitleFrom,
  srTicketBody,
  srTicketSummary,
  type SrTrack,
} from "./jiraSrTicket.ts";
import { JiraMaybeCreatedError, createSrIssue, jiraSrConfig } from "./jiraWrite.ts";

export type TicketOutcome =
  /** 기능이 꺼져 있다(기본값). 아무것도 하지 않았다. */
  | { readonly state: "off" }
  /**
   * 만들었다. `linked: false` 면 티켓은 있는데 **연결을 남기지 못했다** —
   * 그러면 SR 이 끝난 뒤 자동 댓글 대상에서 빠지므로 사람이 알아야 한다.
   */
  | {
      readonly state: "ok";
      readonly key: string;
      readonly url: string;
      readonly dropped: readonly string[];
      readonly linked: boolean;
    }
  /**
   * **만들어졌는지 모른다**(타임아웃·망 오류·5xx). "못 만들었다" 와 섞으면 사람이
   * 하나 더 만들어 티켓이 두 개 된다. 그래서 따로 둔다 — 화면은 "Jira 에서 먼저
   * 확인하세요" 라고 말한다.
   */
  | { readonly state: "unknown"; readonly message: string }
  /** 만들어지지 않았다(검증 거절·권한). 사람이 직접 만들어도 된다. */
  | { readonly state: "failed"; readonly message: string };

export interface TicketRequest {
  readonly requestId: number;
  readonly caseLabel: string;
  readonly track: SrTrack;
  /** 번역 전 한글 제목. 비면 원문 첫 줄에서 뽑고, 그것도 없으면 영문으로 떨어진다. */
  readonly titleKo: string;
  readonly subjectEn: string;
  /** 사람이 적은 한글 원문. 비면 영문 본문을 쓴다. */
  readonly bodyKo: string;
  readonly bodyEn: string;
  readonly productName: string;
  readonly componentName: string;
}

/**
 * 티켓을 만들고 연결을 남긴다. **던지지 않는다.**
 *
 * `JIRA_AUTO_CREATE=1` 이 아니거나 Atlassian 설정이 없으면 `off` — 아무것도 하지 않고
 * 조용히 돌아간다. 그게 기본값이다(외부에 글을 쓰는 기능은 꺼진 채로 배포한다).
 */
export async function createTicketForSr(input: TicketRequest): Promise<TicketOutcome> {
  const config = jiraSrConfig();
  if (config === null) return { state: "off" };

  const titleKo = input.titleKo.trim() !== "" ? input.titleKo.trim() : koTitleFrom(input.bodyKo);

  /*
   * 티켓 만들기와 연결 남기기를 **따로 감싼다.**
   *
   * 한 try 로 묶어 두면, 티켓은 멀쩡히 만들어졌는데 DB 쓰기가 실패한 경우까지 "실패" 가
   * 된다. 화면은 "직접 만들어 주세요" 라고 안내하고 사람은 하나를 더 만든다 — 같은 SR 에
   * 티켓이 두 개 남는다.
   */
  let made: { key: string; url: string; dropped: readonly string[] };
  try {
    const ticket = {
      caseLabel: input.caseLabel,
      titleKo,
      subjectEn: input.subjectEn,
      track: input.track ?? DEFAULT_TRACK,
      productName: input.productName,
      componentName: input.componentName,
      bodyKo: input.bodyKo.trim() !== "" ? input.bodyKo : input.bodyEn,
      // 포털의 케이스별 주소 형식을 확인하지 못했다. **지어내지 않는다** — 깨진 링크가
      // 티켓마다 박히는 것보다 없는 편이 낫다. 케이스 번호는 본문 제목에 들어간다.
      caseUrl: "",
    };

    made = await createSrIssue(config, {
      summary: srTicketSummary(ticket),
      description: srTicketBody(ticket),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[jira] SR 티켓 생성 실패(SR 등록 자체는 성공):", error);
    // 보냈는데 답을 못 받은 것과 거절당한 것을 **가른다.** 섞으면 티켓이 두 개 된다.
    return error instanceof JiraMaybeCreatedError
      ? { state: "unknown", message }
      : { state: "failed", message };
  }

  // 여기부터는 티켓이 **있다.** 아래가 실패해도 "만들었다" 가 뒤집히지 않는다.
  let linked = true;
  try {
    const db = await openDb();
    try {
      await saveSrJiraLink(db, {
        requestId: input.requestId,
        issueKey: made.key,
        issueUrl: made.url,
        track: input.track ?? DEFAULT_TRACK,
        titleKo,
      });
    } finally {
      await db.close();
    }
  } catch (error) {
    linked = false;
    console.error(
      `[jira] 티켓 ${made.key} 은 만들었지만 연결을 남기지 못했습니다(자동 댓글 대상에서 빠진다):`,
      error,
    );
  }

  return { state: "ok", key: made.key, url: made.url, dropped: made.dropped, linked };
}
