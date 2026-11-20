/**
 * MCP 도구 등록 — 진입점(HTTP·stdio)이 공유한다.
 *
 * 도구 정의와 teamId 확정 방법을 떼어 놓은 파일이다. 도구 콜백은 teamId 를
 * 자기가 구하지 않고 `resolveAuth` 로 물어본다. 그래서 같은 도구 열 개가
 * 두 진입점에서 그대로 쓰인다:
 *
 *   mcp/server.ts  — Streamable HTTP. resolveAuth 가 Authorization 헤더의
 *                    팀 토큰을 검증한다(외부 챗봇·사내 클라이언트용).
 *   mcp/stdio.ts   — 표준입출력. 호스트(클로드 데스크톱 등)가 이 프로세스를
 *                    직접 띄우므로 헤더가 없고, 고정 팀으로 해결한다.
 *
 * ★ 이 파일은 serverDeps.ts 를 값으로 불러온다 → 반드시
 *   `node --conditions=react-server` 로 실행되는 프로세스에서만 import 해야 한다.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AuthResult } from "./auth.ts";
import {
  getCaseHandler,
  getSummaryHandler,
  listCasesHandler,
} from "./readTools.ts";
import {
  buildReportHandler,
  getInstanceCountsHandler,
  getMonthlyCasesHandler,
  getMonthlyWorkHandler,
  setReportPicksHandler,
} from "./reportTools.ts";
import { reportDeps, summaryDeps, writeDeps } from "./serverDeps.ts";
import { createSrHandler, replyHandler } from "./writeTools.ts";

/**
 * 도구 호출 시점에 teamId 를 확정하는 함수.
 *
 * HTTP 진입점은 요청 헤더를 받는다(연결 시점에 한 번 검증했더라도, 도구 호출마다
 * 다시 확정한다 — 팀 사칭을 막는 원칙). stdio 진입점은 헤더가 없어 undefined 가 온다.
 */
export type ResolveAuth = (
  headers: Record<string, string | string[] | undefined> | undefined,
) => Promise<AuthResult>;

function toolJson(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function toolAuthError(auth: AuthResult & { ok: false }): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, message: auth.message }) }], isError: true };
}

/**
 * 도구 등록.
 *
 * ★ stateless 모드(sessionIdGenerator: undefined)에서는 McpServer/Transport 를
 *   요청 하나당 하나씩 새로 만들어야 한다 — SDK 내부(webStandardStreamableHttp.js)가
 *   `!this.sessionIdGenerator && this._hasHandledRequest` 이면
 *   "Stateless transport cannot be reused across requests." 를 던진다(실측 확인:
 *   두 번째 요청부터 500). startup 에 딱 1개만 만들어 공유하던 예전 구조는
 *   실제 MCP 클라이언트의 initialize→initialized→tools/list→tools/call 흐름에서
 *   두 번째 요청(notifications/initialized)부터 즉시 깨졌다.
 *   그래서 이 함수를 요청마다 새 McpServer 에 불러 도구를 다시 등록한다
 *   (등록 자체는 순수 동기 작업이라 매 요청 비용이 무시할 만하다).
 */
export function registerTools(server: McpServer, resolveAuth: ResolveAuth): void {
  server.registerTool(
    "list_cases",
    {
      description: "팀 소유 SR 케이스 목록을 조회한다.",
      inputSchema: {
        scope: z.enum(["open", "closed", "all"]).optional(),
        limit: z.number().int().positive().optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (args, extra) => {
      const auth = await resolveAuth(extra.requestInfo?.headers);
      if (!auth.ok) return toolAuthError(auth);
      return toolJson(await listCasesHandler(auth.teamId, args));
    },
  );

  server.registerTool(
    "get_case",
    {
      description: "케이스 상세(스레드·첨부 포함)를 조회한다.",
      inputSchema: { requestId: z.number() },
    },
    async (args, extra) => {
      const auth = await resolveAuth(extra.requestInfo?.headers);
      if (!auth.ok) return toolAuthError(auth);
      return toolJson(await getCaseHandler(auth.teamId, args));
    },
  );

  server.registerTool(
    "get_summary",
    {
      description: "종료 케이스의 Confluence 정리본을 조회(없으면 생성)한다.",
      inputSchema: {
        requestId: z.number(),
        kind: z.string().optional(),
        force: z.boolean().optional(),
      },
    },
    async (args, extra) => {
      const auth = await resolveAuth(extra.requestInfo?.headers);
      if (!auth.ok) return toolAuthError(auth);
      return toolJson(await getSummaryHandler(summaryDeps, auth.teamId, args));
    },
  );

  server.registerTool(
    "create_sr",
    {
      description: "새 SR 을 등록한다. 그 팀의 세션(로그인)이 있어야 한다.",
      inputSchema: {
        subject: z.string(),
        content: z.string(),
        priorityId: z.number(),
        productId: z.number().optional(),
        componentId: z.number().optional(),
        actor: z.string().optional(),
      },
    },
    async (args, extra) => {
      const auth = await resolveAuth(extra.requestInfo?.headers);
      if (!auth.ok) return toolAuthError(auth);
      return toolJson(await createSrHandler(writeDeps, auth.teamId, args));
    },
  );

  server.registerTool(
    "reply",
    {
      description: "진행중 케이스에 답변을 등록한다. 그 팀의 세션(로그인)이 있어야 한다.",
      inputSchema: {
        requestId: z.number(),
        text: z.string(),
        actor: z.string().optional(),
      },
    },
    async (args, extra) => {
      const auth = await resolveAuth(extra.requestInfo?.headers);
      if (!auth.ok) return toolAuthError(auth);
      return toolJson(await replyHandler(writeDeps, auth.teamId, args));
    },
  );

  /* ---------------- 정기점검 보고서 ---------------- */

  // 연·월은 숫자 둘로 받는다. "2026-08" 로 합쳐 받으면 챗봇이 연도를 스스로 알아내야
  // 하는데, 사용자는 "8월달" 이라고만 말하는 것이 보통이다.
  const yearArg = z.number().int().min(2000).max(2100).describe("연도 4자리 (예: 2026)");
  const monthArg = z.number().int().min(1).max(12).describe("월 1~12 (예: 8)");
  // 인스턴스 수치는 평평한 숫자 아홉 개다. 중첩 객체로 받으면 붙는 쪽 클라이언트가
  // 그 JSON Schema 를 다룬다는 보장이 없다.
  const countArg = (label: string) => z.number().min(0).optional().describe(label);

  server.registerTool(
    "get_monthly_work",
    {
      description:
        "정기점검 보고서의 '작업 진행 현황' 을 그 달 Jira 에서 만든다. " +
        "같은 작업 내역은 한 줄로 합쳐지며, 법인과 전산센터 중 한쪽만 여럿일 수 있다. " +
        "보고서에서 빠진 이슈는 skipped 에 이유와 함께 담긴다. " +
        "각 줄의 key 가 선택에 쓰는 값이고, no 는 사용자에게 보여 줄 번호다. " +
        "picked 가 비어 있으면 전부 들어간다 — 뺄 것이 있으면 set_report_picks 를 쓴다.",
      inputSchema: { year: yearArg, month: monthArg },
    },
    async (args, extra) => {
      const auth = await resolveAuth(extra.requestInfo?.headers);
      if (!auth.ok) return toolAuthError(auth);
      return toolJson(await getMonthlyWorkHandler(reportDeps, args));
    },
  );

  // 고를 항목은 배열이 아니라 쉼표로 이은 문자열로 받는다. 이 파일의 다른 인자와 같은
  // 이유다 — 붙는 쪽이 배열 스키마를 다룬다는 보장이 없다.
  const keyListArg = (label: string) =>
    z.string().optional().describe(label);

  server.registerTool(
    "get_monthly_cases",
    {
      description:
        "정기점검 보고서에 넣을 SR 후보(그 달에 등록된 케이스)를 조회한다. " +
        "각 줄의 key 가 선택에 쓰는 값이고, no 는 사용자에게 보여 줄 번호다. " +
        "picked 는 지금 저장된 선택이다. **SR 은 고르지 않으면 보고서를 만들 수 없다.**",
      inputSchema: { year: yearArg, month: monthArg },
    },
    async (args, extra) => {
      const auth = await resolveAuth(extra.requestInfo?.headers);
      if (!auth.ok) return toolAuthError(auth);
      return toolJson(await getMonthlyCasesHandler(reportDeps, args));
    },
  );

  server.registerTool(
    "set_report_picks",
    {
      description:
        "보고서에 넣을 항목을 고른다. 화면의 2·3단계와 같은 곳에 저장되므로 " +
        "채팅에서 고른 것이 화면에도 그대로 보인다. " +
        "남길 것을 keys 에 주거나, 뺄 것을 excludeKeys 에 준다(둘 중 하나만). " +
        "값은 목록 조회에서 받은 key 를 쉼표로 이어 준다 — 번호(no)가 아니다. " +
        "목록에 없는 key 는 저장하지 않고 unknownKeys 로 돌려준다.",
      inputSchema: {
        year: yearArg,
        month: monthArg,
        kind: z.enum(["sr", "jira"]).describe('"sr" = SR 목록, "jira" = 작업 진행 현황'),
        keys: keyListArg('남길 항목의 key 를 쉼표로 이어 준다 (예: "PA-101, PA-104")'),
        excludeKeys: keyListArg('뺄 항목의 key 를 쉼표로 이어 준다 (예: "PA-112, PA-130")'),
      },
    },
    async (args, extra) => {
      const auth = await resolveAuth(extra.requestInfo?.headers);
      if (!auth.ok) return toolAuthError(auth);
      return toolJson(await setReportPicksHandler(reportDeps, args));
    },
  );

  server.registerTool(
    "get_instance_counts",
    {
      description:
        "그 달 보고서의 인스턴스 수치(저장된 것)를 조회한다. " +
        "저장된 것이 없으면 saved 가 null 이고, required 에 채워야 할 아홉 칸이 담긴다.",
      inputSchema: { year: yearArg, month: monthArg },
    },
    async (args, extra) => {
      const auth = await resolveAuth(extra.requestInfo?.headers);
      if (!auth.ok) return toolAuthError(auth);
      return toolJson(await getInstanceCountsHandler(reportDeps, args));
    },
  );

  server.registerTool(
    "build_report",
    {
      description:
        "정기점검 보고서를 받을 수 있는 다운로드 주소를 돌려준다. " +
        "SR 을 먼저 골라 두어야 한다(set_report_picks). " +
        "인스턴스 수치 아홉 개를 함께 주면 저장한 뒤 주소를 준다. " +
        "안 주면 저장된 값을 쓰고, 그것도 없으면 무엇을 물어봐야 하는지 알려 준다. " +
        "전월값은 이전 달 저장분에서 자동으로 끌어온다. " +
        "파일은 이 주소를 열 때 만들어지며 몇 분 걸릴 수 있다.",
      inputSchema: {
        year: yearArg,
        month: monthArg,
        bankDev: countArg("은행 개발"),
        bankProd: countArg("은행 운영"),
        bankDr: countArg("은행 DR"),
        centralDev: countArg("중앙회 개발"),
        centralProd: countArg("중앙회 운영"),
        centralDr: countArg("중앙회 DR"),
        sharedDev: countArg("공동 ORG 개발"),
        sharedProd: countArg("공동 ORG 운영"),
        sharedDr: countArg("공동 ORG DR"),
      },
    },
    async (args, extra) => {
      const auth = await resolveAuth(extra.requestInfo?.headers);
      if (!auth.ok) return toolAuthError(auth);
      return toolJson(await buildReportHandler(reportDeps, args));
    },
  );
}
