/**
 * MCP 서버 진입점.
 *
 * 기존 SR 함수(케이스 조회·상세·작성·답변·요약)를 MCP 도구로 노출한다.
 * 외부 챗봇이 팀 토큰(Authorization: Bearer <token>)을 들고 Streamable HTTP 로 붙는다.
 *
 * ★ 반드시 `node --conditions=react-server mcp/server.ts` 로 띄워야 한다
 *   (package.json 의 "mcp" 스크립트). lib/reply.ts·lib/createCase.ts·
 *   lib/refreshCase.ts·lib/summary.ts 가 "server-only" 마커를 달고 있어서,
 *   이 조건 없이 일반 node 로 실행하면 그 모듈을 불러오는 즉시 throw 한다
 *   (node_modules/server-only 는 "react-server" 조건에서만 무해한 빈 모듈로 풀린다).
 *
 * 브로드컴 인증(OTP·로그인)은 하지 않는다. 팀 세션이 이미 있어야(다른 경로로
 * 로그인된 상태) 쓰기 도구가 동작한다 — 없으면 "SR 페이지에서 로그인하세요"를 돌려준다.
 */
import { loadEnv } from "../lib/env.ts";
loadEnv();

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { openDb, type Db } from "../lib/db.ts";
import { authenticateToken, type AuthResult } from "./auth.ts";
import { AuthRateLimiter } from "./rateLimit.ts";
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

// Cloud Foundry/TAS 는 앱이 반드시 자기가 지정한 $PORT 에 바인딩하길 요구한다
// (그 포트로 헬스체크를 한다). 그래서 PORT 를 최우선으로 본다. 없으면(로컬)
// MCP_PORT, 그것도 없으면 3900.
const PORT = Number(process.env.PORT ?? process.env.MCP_PORT ?? 3900);
/**
 * 안전기본: 명시하지 않으면 루프백(127.0.0.1)에만 바인딩한다.
 * 배포에서 외부로 열려면 HOST=0.0.0.0 을 명시적으로 줘야 한다 — TLS 없이
 * 실수로 모든 인터페이스에 노출되면 Bearer 토큰이 평문으로 오간다(Step 4 보안 리뷰).
 */
const HOST = process.env.HOST ?? "127.0.0.1";

// 토큰 검증용 DB. 지연(lazy) 오픈 — 起動 시점에 DB 가 잠깐 안 붙어도 서버는 뜬다.
// 예전엔 최상위 `await openDb()` 라 DB 가 실패하면 프로세스가 통째로 죽어(all instances
// crashed) TAS 가 크래시루프에 빠졌다. 이제 첫 요청에서 열고, 실패하면 그 요청만 실패하며
// 다음 요청에서 다시 시도한다(서버는 계속 살아 있다 — web 라우트의 동작과 같은 원칙).
let authDbPromise: Promise<Db> | null = null;
function getAuthDb(): Promise<Db> {
  if (!authDbPromise) {
    authDbPromise = openDb().catch((error: unknown) => {
      authDbPromise = null; // 실패는 캐시하지 않는다 — 다음 요청에서 재시도
      throw error;
    });
  }
  return authDbPromise;
}
const limiter = new AuthRateLimiter();

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** extra.requestInfo?.headers 에서 도구 호출 시점의 팀을 다시 확정한다. */
async function authenticateFromToolHeaders(
  headers: Record<string, string | string[] | undefined> | undefined,
): Promise<AuthResult> {
  const raw = headers ? firstHeaderValue(headers["authorization"] ?? headers["Authorization"]) : undefined;
  let db: Db;
  try {
    db = await getAuthDb();
  } catch {
    // DB 가 일시적으로 안 붙으면 인증을 통과시키지 않는다(fail closed).
    return { ok: false, status: 401, message: "인증 서비스를 일시적으로 사용할 수 없습니다." };
  }
  return authenticateToken(db, raw);
}

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
function registerTools(server: McpServer): void {
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
      const auth = await authenticateFromToolHeaders(extra.requestInfo?.headers);
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
      const auth = await authenticateFromToolHeaders(extra.requestInfo?.headers);
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
      const auth = await authenticateFromToolHeaders(extra.requestInfo?.headers);
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
      const auth = await authenticateFromToolHeaders(extra.requestInfo?.headers);
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
      const auth = await authenticateFromToolHeaders(extra.requestInfo?.headers);
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
      const auth = await authenticateFromToolHeaders(extra.requestInfo?.headers);
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
      const auth = await authenticateFromToolHeaders(extra.requestInfo?.headers);
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
      const auth = await authenticateFromToolHeaders(extra.requestInfo?.headers);
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
      const auth = await authenticateFromToolHeaders(extra.requestInfo?.headers);
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
      const auth = await authenticateFromToolHeaders(extra.requestInfo?.headers);
      if (!auth.ok) return toolAuthError(auth);
      return toolJson(await buildReportHandler(reportDeps, args));
    },
  );
}

function sourceKeyOf(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** 연결이 끝나면(정상 종료든 중도 절단이든) 이번 요청 전용 인스턴스를 정리한다. */
function closeQuietly(closeable: { close: () => Promise<void> }, label: string): void {
  closeable.close().catch((error: unknown) => {
    console.error(`[mcp] ${label} 정리 실패`, error);
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const key = sourceKeyOf(req);

  if (limiter.isBlocked(key)) {
    sendJson(res, 429, { error: "요청이 너무 잦습니다. 잠시 후 다시 시도하세요." });
    return;
  }

  // 접속(요청) 시점의 1차 인증 — 실패는 여기서 401 로 끝내고 rate limit 카운터를 올린다.
  // 도구 호출 시점에는 각 도구 콜백이 헤더를 다시 검증해 teamId 를 확정한다.
  let authDb: Db;
  try {
    authDb = await getAuthDb();
  } catch (error) {
    // DB 가 안 붙어도 서버는 살아 있고, 이 요청만 503 으로 끝낸다(크래시 없음).
    console.error("[mcp] 인증 DB 열기 실패", error instanceof Error ? error.message : String(error));
    sendJson(res, 503, { error: "db_unavailable" });
    return;
  }
  const auth = await authenticateToken(authDb, req.headers.authorization);
  if (!auth.ok) {
    limiter.recordFailure(key);
    sendJson(res, auth.status, { error: auth.message });
    return;
  }
  limiter.recordSuccess(key);

  // stateless 정석: 요청마다 새 McpServer + 새 Transport (위 registerTools 주석 참고).
  const server = new McpServer({ name: "broadcom-sr-mcp", version: "0.1.0" });
  registerTools(server);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  // 응답이 끝나면(성공/중도절단 모두) 이번 요청 전용 인스턴스를 반드시 닫는다 — 안 그러면
  // 요청마다 새로 만든 McpServer/Transport 가 누적돼 메모리가 샌다.
  res.on("close", () => {
    closeQuietly(transport, "transport");
    closeQuietly(server, "server");
  });

  await transport.handleRequest(req, res);
}

const httpServer = createServer((req, res) => {
  handleRequest(req, res).catch((error: unknown) => {
    console.error("[mcp] 요청 처리 실패", error);
    if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
  });
});

httpServer.listen(PORT, HOST, () => {
  console.log(`[mcp] broadcom-sr-mcp listening on ${HOST}:${PORT}`);
});
