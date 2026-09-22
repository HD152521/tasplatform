/**
 * MCP 서버 e2e 테스트.
 *
 * 순수 핸들러 단위테스트(mcpReadTools/mcpWriteTools)는 실제 SDK 클라이언트가
 * initialize→initialized→tools/list→tools/call 을 완주하는지는 검증하지 못한다
 * (실측 결함: stateless 모드에서 McpServer/Transport 를 startup 에 1개만 만들어
 * 공유하면 두 번째 요청부터 500 이 났다 — 단위테스트는 통과하는데 실제 서버는 죽는
 * 케이스였다). 그래서 이 파일은 실제 mcp/server.ts 를 별도 프로세스로 띄우고,
 * 공식 @modelcontextprotocol/sdk 의 Client + StreamableHTTPClientTransport 로
 * 진짜 HTTP 로 붙어서 검증한다.
 *
 * server-only 주의: mcp/server.ts 는 lib/reply.ts 등 "server-only" 마커가 붙은
 * 모듈을 불러오므로 반드시 `node --conditions=react-server` 로 띄워야 한다
 * (package.json 의 "mcp" 스크립트와 동일). 이 테스트 프로세스 자체(node --test)는
 * 그 조건이 없어도 된다 — 우리는 그 모듈을 이 프로세스에 불러오지 않고, 자식
 * 프로세스로만 띄우기 때문이다.
 *
 * 쓰기 도구(create_sr/reply)는 실제로 Broadcom 에 등록되므로, 여기서는 세션이
 * 없는 팀으로 reply 를 호출해 "세션 없음" 사전점검까지만 확인한다(실제 전송 금지).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb, upsertCase, upsertTeam } from "../lib/db.ts";
import { issueTeamToken } from "../lib/teamToken.ts";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const STARTUP_TIMEOUT_MS = 15_000;

function randomPort(): number {
  return 40_000 + Math.floor(Math.random() * 10_000);
}

interface RunningServer {
  port: number;
  stop: () => Promise<void>;
}

/** mcp/server.ts 를 `node --conditions=react-server` 로 실제 실행한다(자식 프로세스). */
async function startServer(dbFile: string): Promise<RunningServer> {
  const port = randomPort();
  const proc: ChildProcessByStdio<null, Readable, Readable> = spawn(
    process.execPath,
    ["--conditions=react-server", "mcp/server.ts"],
    {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        MCP_PORT: String(port),
        HOST: "127.0.0.1",
        SR_DB_FILE: dbFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stderrBuf = "";
  proc.stderr.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString();
  });

  await new Promise<void>((resolveStartup, rejectStartup) => {
    const timer = setTimeout(() => {
      rejectStartup(new Error(`MCP 서버가 제시간에 뜨지 않았다.\nstderr:\n${stderrBuf}`));
    }, STARTUP_TIMEOUT_MS);

    let stdoutBuf = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      if (stdoutBuf.includes("listening on")) {
        clearTimeout(timer);
        resolveStartup();
      }
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      rejectStartup(new Error(`MCP 서버 프로세스가 조기 종료됐다 (code=${code}).\nstderr:\n${stderrBuf}`));
    });
    proc.once("error", (error) => {
      clearTimeout(timer);
      rejectStartup(error);
    });
  });

  const stop = async (): Promise<void> => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    proc.kill("SIGTERM");
    await new Promise<void>((resolveStop) => {
      const forceKill = setTimeout(() => {
        proc.kill("SIGKILL");
        resolveStop();
      }, 5_000);
      proc.once("exit", () => {
        clearTimeout(forceKill);
        resolveStop();
      });
    });
  };

  return { port, stop };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const first = result.content[0];
  assert.equal(first?.type, "text");
  return JSON.parse(first?.text ?? "null");
}

async function connectedClient(port: number, token: string): Promise<Client> {
  const client = new Client({ name: "e2e-test-client", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  );
  await client.connect(transport);
  return client;
}

test(
  "실제 SDK 클라이언트로 initialize~tools/call 을 완주한다",
  { timeout: 30_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "srhub-mcp-e2e-"));
    const dbFile = join(dir, "test.db");

    // 서버를 띄우기 전에 테스트 데이터를 심는다(같은 db 파일, 서버 시작 전 close).
    const db = await openDb(dbFile);
    await upsertTeam(db, { team_id: "e2e-team", team_name: "E2E 팀", broadcom_username: "" });
    const issued = await issueTeamToken(db, "e2e-team", "e2e 테스트");
    await upsertCase(db, {
      request_id: 990001, request_id_formatted: "990001", subject: "e2e 테스트 케이스",
      status: "Open", priority: "P3", category: "Ops", party_name: "고객사",
      party_site_number: "1", created_on: "01-September-2026 23:39:29",
      created_on_ms: 1, last_updated: "01-September-2026 23:39:29", last_updated_ms: 1,
      last_fetched_at: "2026-09-02T00:00:00Z", raw_json: "{}",
      description_html: "", description_text: "", case_version: null,
      product_id: null, product_name: "", component_id: null, component_name: "",
      team_id: "e2e-team",
    });
    await db.close();

    const server = await startServer(dbFile);
    try {
      // ── 유효 토큰: initialize → initialized → tools/list → tools/call ──
      const client = await connectedClient(server.port, issued.token);
      try {
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name).sort();
        // 도구 목록을 못 박아 둔다 — 붙는 쪽이 보는 표면이라 모르는 사이에 늘거나 줄면 안 된다.
        assert.deepEqual(
          names,
          [
            // SR
            "create_sr", "get_case", "get_summary", "list_cases", "reply",
            // 정기점검 보고서
            "build_report", "get_instance_counts", "get_monthly_work",
            "get_monthly_cases", "set_report_picks",
          ].sort(),
        );

        const listResult = await client.callTool({ name: "list_cases", arguments: {} });
        const listPayload = textOf(listResult as { content: Array<{ type: string; text?: string }> }) as {
          ok: boolean; cases: Array<{ request_id: number }>; total: number;
        };
        assert.equal(listPayload.ok, true);
        assert.equal(listPayload.total, 1);
        assert.equal(listPayload.cases[0]?.request_id, 990001);

        // 두 번째(reply, 세션 없음)와 세 번째(get_case) tools/call 도 성공해야 한다
        // — 이게 이번에 고친 "두 번째 요청부터 500" 결함의 핵심 재현/회귀 지점이다.
        const getCaseResult = await client.callTool({
          name: "get_case", arguments: { requestId: 990001 },
        });
        const getCasePayload = textOf(getCaseResult as { content: Array<{ type: string; text?: string }> }) as {
          ok: boolean;
        };
        assert.equal(getCasePayload.ok, true);

        // ── 세션 없는 팀의 reply: 사전점검에서 "세션 없음"으로 막혀야 한다
        //    (실제 Broadcom 전송은 절대 일어나지 않아야 하므로 여기서 검증을 멈춘다) ──
        const replyResult = await client.callTool({
          name: "reply", arguments: { requestId: 990001, text: "테스트 답변" },
        });
        const replyPayload = textOf(replyResult as { content: Array<{ type: string; text?: string }> }) as {
          ok: boolean; code?: string; message?: string;
        };
        assert.equal(replyPayload.ok, false);
        assert.equal(replyPayload.code, "session");
      } finally {
        await client.close();
      }

      // ── 무효 토큰: 연결 자체가 거부돼야 한다 ──
      const badClient = new Client({ name: "e2e-bad-client", version: "0.0.1" });
      const badTransport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${server.port}/mcp`),
        { requestInit: { headers: { Authorization: "Bearer not-a-real-token" } } },
      );
      await assert.rejects(() => badClient.connect(badTransport));
    } finally {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
