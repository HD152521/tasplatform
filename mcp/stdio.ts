/**
 * MCP 서버 진입점 — 표준입출력(stdio).
 *
 * 쓰는 곳: 클로드 데스크톱처럼 **호스트가 서버 프로세스를 직접 띄우는** 클라이언트.
 * 호스트가 이 프로세스를 자식으로 실행하고 stdin/stdout 으로 MCP 를 주고받는다.
 * 도구는 mcp/tools.ts 의 열 개를 HTTP 진입점(mcp/server.ts)과 그대로 공유한다.
 *
 * ★ 반드시 `node --conditions=react-server mcp/stdio.ts` 로 띄워야 한다
 *   (package.json 의 "mcp:stdio"). mcp/tools.ts → serverDeps.ts 가 "server-only"
 *   모듈(lib/reply.ts 등)을 값으로 불러오기 때문이다 — server.ts 와 같은 이유.
 *
 * 인증이 없는 이유: 호스트가 이 프로세스를 로컬에서 띄우므로 네트워크 경계가 없다.
 * 토큰을 받을 헤더 자체가 없다. 대신 **이 프로세스를 띄울 수 있는 사람은 그 팀의
 * 권한을 전부 갖는다** — `npm run collect` 를 돌릴 수 있는 것과 같은 수준이다.
 * 팀을 바꾸려면 SR_DEFAULT_TEAM 을 준다(lib/config.ts 의 DEFAULT_TEAM_ID).
 *
 * ★ stdout 은 MCP 프로토콜 전용이다. 아무 모듈이든 console.log 를 한 줄 흘리면
 *   JSON-RPC 스트림이 깨져 호스트가 연결을 끊는다(실측: 수집·DB 모듈이 기동 로그를
 *   찍는다). 그래서 transport 를 붙이기 **전에** 로그 계열을 전부 stderr 로 돌린다.
 *   stderr 는 호스트가 로그로 수집하므로 진단에는 지장이 없다.
 */
const writeErr = (...args: readonly unknown[]): void => {
  process.stderr.write(
    args.map((a) => (typeof a === "string" ? a : String(a))).join(" ") + "\n",
  );
};
console.log = writeErr;
console.info = writeErr;
console.debug = writeErr;

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../lib/env.ts";

// ★ 호스트가 어느 폴더에서 띄울지 알 수 없다(클로드 데스크톱은 자기 작업폴더에서
//   자식 프로세스를 띄운다). 이 레포는 .env·data/sr.db·templates 를 **상대경로**로
//   찾으므로, 그 전에 레포 루트로 옮겨 앉는다. 그래서 설정에 cwd 를 적지 않아도 된다.
process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), ".."));

loadEnv();

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_TEAM_ID } from "../lib/config.ts";
import type { AuthResult } from "./auth.ts";
import { registerTools } from "./tools.ts";

/** 헤더가 없으므로 고정 팀으로 해결한다. 실패 경로가 없다. */
async function resolveFixedTeam(): Promise<AuthResult> {
  return { ok: true, teamId: DEFAULT_TEAM_ID };
}

const server = new McpServer({ name: "broadcom-sr-mcp", version: "0.1.0" });
registerTools(server, resolveFixedTeam);

// HTTP 진입점과 달리 McpServer 를 요청마다 새로 만들지 않는다 — stdio 는 연결이
// 하나이고 수명이 프로세스와 같다(stateless transport 재사용 제약은 HTTP 전용이다).
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[mcp-stdio] broadcom-sr-mcp 준비됨 (팀 ${DEFAULT_TEAM_ID})`);
