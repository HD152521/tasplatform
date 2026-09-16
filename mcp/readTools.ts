/**
 * MCP 읽기 도구(list_cases / get_case / get_summary)의 순수 핸들러 로직.
 *
 * lib/queries.ts 는 server-only 가 아니라서 그대로 직접 불러 쓴다(재사용).
 * 다만 lib/summary.ts(getSummary)는 server-only 라 이 파일에서 값으로 불러오면
 * `node --test` 에서 못 불러온다(requestAudit.ts 의 관례와 동일한 이유) — 그래서
 * getSummary 는 ReadDeps 로 주입받는다. 타입만 필요한 것은 `import type` 이라
 * 런타임에 그 모듈을 불러오지 않으므로 안전하다.
 *
 * mcp/server.ts 가 mcp/serverDeps.ts(진짜 getSummary)를 넘겨 이 핸들러를 실제로 쓴다.
 */
import {
  type AttachmentViewRow,
  type CaseListRow,
  type ThreadViewRow,
  getCase as queryGetCase,
  isClosedStatus,
  listAttachments,
  listCases,
  listThreads,
} from "../lib/queries.ts";
import type { Summary, SummaryKind } from "../lib/summary.ts";

// lib/summary.ts 의 SUMMARY_KINDS 를 그대로 값으로 불러오면 server-only 가 걸린다.
// 지금은 kind 가 "confluence" 하나뿐이라 값만 가볍게 미러링한다(값 자체를 새로 만드는 게
// 아니라 이미 정해진 상수를 다시 적은 것 — 늘어나면 SUMMARY_KINDS 쪽도 같이 봐야 한다).
const VALID_SUMMARY_KINDS: ReadonlySet<string> = new Set(["confluence"]);

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

// ── list_cases ──────────────────────────────────────────────────────

export interface ListCasesArgs {
  scope?: "open" | "closed" | "all";
  limit?: number;
  offset?: number;
}

export interface ListCasesResult {
  ok: true;
  cases: CaseListRow[];
  total: number;
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

export async function listCasesHandler(
  teamId: string,
  args: ListCasesArgs,
  dbFile?: string,
): Promise<ListCasesResult> {
  const scope = args.scope ?? "all";
  const limit = clamp(args.limit ?? DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
  const offset = clamp(args.offset ?? 0, 0, Number.MAX_SAFE_INTEGER);

  const all = await listCases({ teamId, dbFile });
  const filtered =
    scope === "all" ? all : all.filter((c) => isClosedStatus(c.status) === (scope === "closed"));

  return {
    ok: true,
    cases: filtered.slice(offset, offset + limit),
    total: filtered.length,
  };
}

// ── get_case ────────────────────────────────────────────────────────

export interface GetCaseArgs {
  requestId: number;
}

export type GetCaseResult =
  | { ok: true; case: CaseListRow; threads: ThreadViewRow[]; attachments: AttachmentViewRow[] }
  | { ok: false; message: string };

export async function getCaseHandler(
  teamId: string,
  args: GetCaseArgs,
  dbFile?: string,
): Promise<GetCaseResult> {
  const requestId = Number(args.requestId);
  if (!Number.isFinite(requestId)) {
    return { ok: false, message: "requestId 가 올바르지 않습니다." };
  }

  // teamId 로 좁혀서 조회한다 — 다른 팀 케이스는 없는 것과 동일하게 취급된다.
  const detail = await queryGetCase(requestId, { teamId, dbFile });
  if (detail === null) {
    return { ok: false, message: "케이스를 찾을 수 없습니다." };
  }

  return {
    ok: true,
    case: detail,
    threads: await listThreads(requestId, dbFile),
    attachments: await listAttachments(requestId, dbFile),
  };
}

// ── get_summary ─────────────────────────────────────────────────────

export interface GetSummaryArgs {
  requestId: number;
  kind?: string;
  force?: boolean;
}

export type GetSummaryResult =
  | { ok: true; summary: Summary }
  | { ok: false; message: string };

export interface GetSummaryDeps {
  getSummary: (requestId: number, kind: SummaryKind, force?: boolean) => Promise<Summary | { error: string }>;
  dbFile?: string;
}

export async function getSummaryHandler(
  deps: GetSummaryDeps,
  teamId: string,
  args: GetSummaryArgs,
): Promise<GetSummaryResult> {
  const requestId = Number(args.requestId);
  if (!Number.isFinite(requestId)) {
    return { ok: false, message: "requestId 가 올바르지 않습니다." };
  }

  const kind = args.kind ?? "confluence";
  if (!VALID_SUMMARY_KINDS.has(kind)) {
    return { ok: false, message: `지원하지 않는 kind 입니다: ${kind}` };
  }

  // 다른 팀 케이스의 정리본을 못 얻어가도록, 소유 확인을 먼저 한다.
  const owned = await queryGetCase(requestId, { teamId, dbFile: deps.dbFile });
  if (owned === null) {
    return { ok: false, message: "케이스를 찾을 수 없습니다." };
  }

  const result = await deps.getSummary(requestId, kind as SummaryKind, args.force ?? false);
  if ("error" in result) {
    return { ok: false, message: result.error };
  }
  return { ok: true, summary: result };
}
