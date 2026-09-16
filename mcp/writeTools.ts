/**
 * MCP 쓰기 도구(create_sr / reply)의 순수 핸들러 로직.
 *
 * lib/reply.ts(postReply)·lib/createCase.ts(createCase)·lib/refreshCase.ts 는
 * server-only 라 이 파일에서 값으로 불러오면 `node --test` 에서 못 불러온다
 * (lib/requestAudit.ts 주석의 관례와 동일한 이유로 실측 확인). 그래서 실제 실행
 * 함수는 WriteDeps 로 주입받는다 — 타입은 `import type` 이라 런타임 영향이 없다.
 *
 * mcp/server.ts 가 mcp/serverDeps.ts(진짜 postReply/createCase/refresh*)를 넘겨
 * 이 핸들러가 실제로 그 함수들을 쓰게 한다.
 *
 * 공통 규칙(계획서 "쓰기 도구 공통 규칙" 그대로):
 *   1. teamId 는 토큰에서 확정된 값을 그대로 받는다(도구 인자로는 절대 안 받는다 —
 *      그러면 팀 사칭이 가능해진다).
 *   2. 세션 사전점검: hasTeamSession(teamId) 가 false 면 실행하지 않는다.
 *   3. 부수효과(persist·refresh)는 runSideEffect 로 감싸 실패해도 성공을 뒤집지 않는다.
 *   4. 성공/실패 모두 recordWriteAudit 로 남긴다.
 */
import type { ApiClient, HttpClient } from "../collector/httpClient.ts";
import type { CreateResult } from "../lib/createCase.ts";
import { isClosedStatus, getCase as queryGetCase } from "../lib/queries.ts";
import type { ReplyResult } from "../lib/reply.ts";
import { recordWriteAudit, runSideEffect } from "../lib/requestAudit.ts";

/**
 * lib/createCase.ts 의 PRIORITIES 를 값으로 불러오면 server-only 가 걸리므로
 * id 목록만 미러링한다(정의가 늘면 lib/createCase.ts 쪽도 같이 봐야 한다).
 * Critical=1 / High=2 / Medium=3 / Low=4.
 */
const VALID_PRIORITY_IDS: ReadonlySet<number> = new Set([1, 2, 3, 4]);

export interface WriteDeps {
  hasTeamSession: (teamId: string) => boolean;
  fetchClient: (sessionFile: string) => HttpClient;
  sessionFileForTeam: (teamId: string) => string;
  postReply: (client: ApiClient, requestId: number, text: string) => Promise<ReplyResult>;
  createCase: (
    client: ApiClient,
    input: { subject: string; content: string; priorityId: number; productId?: number; componentId?: number },
  ) => Promise<CreateResult>;
  refreshCaseThreads: (client: ApiClient, requestId: number) => Promise<boolean>;
  refreshOpenCases: (client: ApiClient, teamId?: string) => Promise<boolean>;
  /** 테스트에서 임시 DB 를 가리키기 위한 것. 실제 서버 호출부는 생략한다. */
  dbFile?: string;
}

function pickActor(args: { actor?: unknown }): string {
  return typeof args.actor === "string" ? args.actor.trim() : "";
}

function sessionDenied(): { ok: false; code: "session"; message: string } {
  return { ok: false, code: "session", message: "세션이 없습니다. SR 페이지에서 로그인하세요." };
}

// ── create_sr ───────────────────────────────────────────────────────

export interface CreateSrArgs {
  subject?: unknown;
  content?: unknown;
  priorityId?: unknown;
  productId?: unknown;
  componentId?: unknown;
  actor?: unknown;
}

export type CreateSrHandlerResult =
  | CreateResult
  | { ok: false; code: "invalid"; message: string };

export async function createSrHandler(
  deps: WriteDeps,
  teamId: string,
  args: CreateSrArgs,
): Promise<CreateSrHandlerResult> {
  const actor = pickActor(args);
  const subject = typeof args.subject === "string" ? args.subject.trim() : "";
  const content = typeof args.content === "string" ? args.content.trim() : "";
  const priorityId = Number(args.priorityId);

  if (subject === "" || content === "") {
    return { ok: false, code: "invalid", message: "제목과 내용을 입력하세요." };
  }
  if (!VALID_PRIORITY_IDS.has(priorityId)) {
    return { ok: false, code: "invalid", message: "우선순위가 올바르지 않습니다." };
  }

  if (!deps.hasTeamSession(teamId)) {
    recordWriteAudit(
      { actor, teamId, action: "create_sr", requestId: null, result: "failed:session" },
      deps.dbFile,
    );
    return sessionDenied();
  }

  const productId = Number(args.productId);
  const componentId = Number(args.componentId);

  const client = deps.fetchClient(deps.sessionFileForTeam(teamId));
  const result = await deps.createCase(client, {
    subject,
    content,
    priorityId,
    productId: Number.isFinite(productId) ? productId : undefined,
    componentId: Number.isFinite(componentId) ? componentId : undefined,
  });

  // 쓰기 성공/실패를 부수효과가 뒤집지 않도록 runSideEffect 로만 건드린다.
  await runSideEffect("mcp create persist", () => client.persist());
  if (result.ok) {
    // 새 케이스가 이 팀 소유로 찍히도록 teamId 를 넘긴다 (이월 항목: team_id 배선).
    await runSideEffect("mcp create refresh", () => deps.refreshOpenCases(client, teamId));
  }

  recordWriteAudit(
    {
      actor,
      teamId,
      action: "create_sr",
      requestId: result.ok ? result.requestId : null,
      result: result.ok ? "ok" : `failed:${result.code}`,
    },
    deps.dbFile,
  );

  return result;
}

// ── reply ───────────────────────────────────────────────────────────

export interface ReplyArgs {
  requestId?: unknown;
  text?: unknown;
  actor?: unknown;
}

export type ReplyHandlerResult =
  | ReplyResult
  | { ok: false; code: "invalid" | "not_found" | "closed"; message: string };

export async function replyHandler(
  deps: WriteDeps,
  teamId: string,
  args: ReplyArgs,
): Promise<ReplyHandlerResult> {
  const actor = pickActor(args);
  const requestId = Number(args.requestId);
  const text = typeof args.text === "string" ? args.text.trim() : "";

  if (!Number.isFinite(requestId) || text === "") {
    return { ok: false, code: "invalid", message: "내용을 입력하세요." };
  }

  // 그 팀 소유 케이스가 아니면 답할 수 없다 — 다른 팀 케이스는 없는 것과 동일하게 취급한다.
  const detail = queryGetCase(requestId, { teamId, dbFile: deps.dbFile });
  if (detail === null) {
    recordWriteAudit(
      { actor, teamId, action: "reply", requestId, result: "failed:not_found" },
      deps.dbFile,
    );
    return { ok: false, code: "not_found", message: "케이스를 찾을 수 없습니다." };
  }
  if (isClosedStatus(detail.status)) {
    recordWriteAudit(
      { actor, teamId, action: "reply", requestId, result: "failed:closed" },
      deps.dbFile,
    );
    return { ok: false, code: "closed", message: "종료된 케이스에는 답변할 수 없습니다." };
  }

  if (!deps.hasTeamSession(teamId)) {
    recordWriteAudit(
      { actor, teamId, action: "reply", requestId, result: "failed:session" },
      deps.dbFile,
    );
    return sessionDenied();
  }

  const client = deps.fetchClient(deps.sessionFileForTeam(teamId));
  const result = await deps.postReply(client, requestId, text);

  await runSideEffect("mcp reply persist", () => client.persist());
  if (result.ok) {
    await runSideEffect("mcp reply refresh", () => deps.refreshCaseThreads(client, requestId));
  }

  recordWriteAudit(
    {
      actor,
      teamId,
      action: "reply",
      requestId,
      result: result.ok ? "ok" : `failed:${result.code}`,
    },
    deps.dbFile,
  );

  return result;
}
