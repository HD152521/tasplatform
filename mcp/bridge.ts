/**
 * MCP 다리 — 배포본(broadcom-sr-mcp)에 붙기 위한 stdio ↔ HTTP 중계.
 *
 * 쓰는 곳: 클로드 데스크톱처럼 **헤더를 넣을 칸이 없는** 호스트. 배포본은 Streamable
 * HTTP 서버이고 `Authorization: Bearer <팀토큰>` 으로만 들여보내는데, 데스크톱의 커넥터
 * 설정에는 임의 헤더를 적는 자리가 없다. 그래서 호스트는 이 프로세스를 stdio 로 띄우고,
 * 이 프로세스가 헤더를 달아 원격에 중계한다.
 *
 *   호스트 ──stdio──▶ bridge.ts ──HTTPS + Bearer──▶ broadcom-sr-mcp (TAS)
 *
 * 도구 정의도 DB 연결도 세션도 여기 없다. **메시지를 그대로 나르기만 한다** — 서버는
 * 배포본이고, 이 파일은 봉투만 바꿔 끼운다. 그래서 `server-only` 모듈을 하나도 물지
 * 않아서 `--conditions=react-server` 없이 평범한 node 로 돈다(mcp/stdio.ts 와 다른 점).
 *
 * ## 환경변수
 *
 *   SR_MCP_URL            원격 주소. 기본 https://broadcom-sr-mcp.apps.nh.ds.lab/mcp
 *   SR_MCP_TOKEN          팀 토큰(필수). `npm run token -- --issue` 로 **배포본이 보는
 *                         DB** 에 발급한 것이어야 한다 — 로컬 sr.db 에 발급한 토큰은
 *                         배포본이 모른다.
 *   SR_MCP_INSECURE_TLS   1 이면 이 연결의 인증서 검증을 건너뛴다.
 *
 * ## 왜 TLS 검증을 건너뛰어야 하는가 (실측)
 *
 * 라우트는 `*.apps.nh.ds.lab` 인데 GoRouter 가 내보내는 인증서는
 * `CN=*.sys.nh.ds.lab` (발급자 `O=Pivotal`, 사설 CA)이다. **이름이 아예 다르므로**
 * 사설 CA 를 신뢰 목록에 넣어도 호스트명 검증을 통과할 수 없다. 플랫폼이 apps 도메인
 * 인증서를 제대로 달아 주기 전까지는 검증을 끌 수밖에 없다(.gitlab-ci.yml 의
 * `cf api --skip-ssl-validation` 과 같은 사정이다).
 *
 * 대신 **프로세스 전체를 열지는 않는다** — NODE_TLS_REJECT_UNAUTHORIZED=0 은 이 프로세스의
 * 모든 TLS 를 끈다. 여기서는 undici Agent 를 이 연결에만 달아 범위를 묶는다. 그래도
 * 사내망 안에서 토큰이 검증 안 된 연결로 오간다는 사실은 남는다 — 인증서가 고쳐지면
 * SR_MCP_INSECURE_TLS 를 지우는 것이 맞다.
 */
const writeErr = (...args: readonly unknown[]): void => {
  process.stderr.write(
    args.map((a) => (typeof a === "string" ? a : String(a))).join(" ") + "\n",
  );
};
// stdout 은 JSON-RPC 전용이다. 한 줄이라도 섞이면 호스트가 연결을 끊는다.
console.log = writeErr;
console.info = writeErr;
console.debug = writeErr;

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, fetch as undiciFetch } from "undici";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { loadEnv } from "../lib/env.ts";

// 호스트가 어느 폴더에서 띄울지 알 수 없다 — .env 를 찾으려면 레포 루트로 옮겨 앉아야
// 한다(mcp/stdio.ts 와 같은 이유).
process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
loadEnv();

const DEFAULT_URL = "https://broadcom-sr-mcp.apps.nh.ds.lab/mcp";
const url = (process.env.SR_MCP_URL ?? DEFAULT_URL).trim();
const token = (process.env.SR_MCP_TOKEN ?? "").trim();
const insecure = /^(1|true|yes|on)$/i.test((process.env.SR_MCP_INSECURE_TLS ?? "").trim());

if (token === "") {
  // 토큰 없이 띄우면 원격이 매 요청 401 을 돌려주고, 호스트에는 "도구가 없다" 로만 보인다.
  // 그 모양이 제일 헷갈리므로 여기서 분명하게 죽는다.
  writeErr("[bridge] SR_MCP_TOKEN 이 없습니다. `npm run token -- --issue` 로 발급한 값을 넣으세요.");
  process.exit(1);
}

/** 검증을 끈 연결은 이 Agent 에만 묶인다. 프로세스의 다른 TLS 는 그대로다. */
const dispatcher = insecure
  ? new Agent({ connect: { rejectUnauthorized: false } })
  : undefined;

const remote = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
  // undici 의 fetch 는 init.dispatcher 를 받는다. 전역 fetch 에 끼우는 대신 이 전송에만 준다.
  fetch: dispatcher
    ? ((input: string | URL | Request, init?: RequestInit) =>
      undiciFetch(input as never, { ...(init as object ?? {}), dispatcher } as never) as never)
    : undefined,
});
const local = new StdioServerTransport();

/** 요청(id 있음)이 실패하면 호스트에 오류로 답한다 — 안 그러면 그 자리에서 영원히 기다린다. */
function errorFor(message: JSONRPCMessage, error: unknown): JSONRPCMessage | null {
  const id = (message as { id?: string | number }).id;
  if (id === undefined || id === null) return null; // 알림(notification)은 답이 없다
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32603,
      message: `배포본에 전달하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
    },
  } as JSONRPCMessage;
}

local.onmessage = (message: JSONRPCMessage): void => {
  remote.send(message).catch((error: unknown) => {
    writeErr(`[bridge] 원격 전송 실패: ${error instanceof Error ? error.message : String(error)}`);
    const reply = errorFor(message, error);
    if (reply) local.send(reply).catch(() => undefined);
  });
};

remote.onmessage = (message: JSONRPCMessage): void => {
  local.send(message).catch((error: unknown) => {
    writeErr(`[bridge] 호스트 전송 실패: ${error instanceof Error ? error.message : String(error)}`);
  });
};

remote.onerror = (error: Error): void => { writeErr(`[bridge] 원격 오류: ${error.message}`); };
local.onerror = (error: Error): void => { writeErr(`[bridge] 호스트 오류: ${error.message}`); };

// 한쪽이 끊기면 다른 쪽도 닫는다 — 반쪽만 남으면 호스트가 응답을 기다리며 멈춘다.
remote.onclose = (): void => { local.close().catch(() => undefined); };
local.onclose = (): void => { remote.close().catch(() => undefined); };

await remote.start();
await local.start();
writeErr(`[bridge] ${url} 로 중계합니다${insecure ? " (TLS 검증 끔)" : ""}`);
