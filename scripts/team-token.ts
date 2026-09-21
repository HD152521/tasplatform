/**
 * 팀 MCP 접속 토큰 발급·조회·해지 CLI.
 *
 * MCP 서버(mcp/server.ts)는 `Authorization: Bearer <token>` 으로만 들여보낸다.
 * 그런데 그 토큰을 만들 수단이 코드 어디에도 없었다 — issueTeamToken 을 부르는 곳이
 * 시험 말고는 없었다. 이 스크립트가 그 구멍을 메운다.
 *
 *   npm run token -- --issue --label "TPCF Workspace"
 *   npm run token -- --list
 *   npm run token -- --revoke <토큰>
 *
 * 토큰은 발급 직후 한 번만 보여 준다. DB 에는 SHA-256 해시만 남아서 다시 꺼낼 수
 * 없다 — 잃어버리면 해지하고 새로 발급한다.
 *
 * 토큰을 인자로 받는 --revoke 는 셸 히스토리와 프로세스 목록에 남는다. 그래서
 * 값 없이 부르면 표준입력에서 읽는다.
 */
import { loadEnv } from "../lib/env.ts";
loadEnv();

import { DEFAULT_TEAM_ID } from "../lib/config.ts";
import { openDb } from "../lib/db.ts";
import { issueTeamToken, listTeamTokens, revokeTeamToken } from "../lib/teamToken.ts";

interface Options {
  action: "issue" | "list" | "revoke" | "help";
  team: string;
  label: string;
  token: string;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { action: "help", team: DEFAULT_TEAM_ID, label: "", token: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1] ?? "";
    switch (arg) {
      case "--issue": options.action = "issue"; break;
      case "--list": options.action = "list"; break;
      case "--revoke":
        options.action = "revoke";
        // 값이 붙어 있으면 쓰되, 없으면 표준입력에서 읽는다(히스토리에 안 남기려고).
        if (next !== "" && !next.startsWith("--")) { options.token = next; i += 1; }
        break;
      case "--team": options.team = next; i += 1; break;
      case "--label": options.label = next; i += 1; break;
      default: break;
    }
  }
  return options;
}

function usage(): void {
  console.log(`팀 MCP 접속 토큰 관리

  npm run token -- --issue [--team <id>] [--label <메모>]
  npm run token -- --list  [--team <id>]
  npm run token -- --revoke [<토큰>]        토큰을 빼면 표준입력에서 읽는다

기본 팀: ${DEFAULT_TEAM_ID} (SR_DEFAULT_TEAM 으로 바꾼다)`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.action === "help") {
    usage();
    return 0;
  }

  const db = await openDb();
  try {
    if (options.action === "issue") {
      const issued = await issueTeamToken(db, options.team, options.label);
      console.log(`팀:   ${options.team}`);
      if (options.label !== "") console.log(`메모: ${options.label}`);
      console.log("");
      console.log("토큰 (이 화면에서만 보입니다):");
      console.log(`  ${issued.token}`);
      console.log("");
      console.log("붙이는 쪽에는 이렇게 넣습니다:");
      console.log(`  Authorization: Bearer ${issued.token}`);
      return 0;
    }

    if (options.action === "list") {
      const rows = await listTeamTokens(db, options.team);
      if (rows.length === 0) {
        console.log(`발급된 토큰이 없습니다 (팀: ${options.team}).`);
        return 0;
      }
      console.log(`팀 ${options.team} 의 토큰 ${rows.length}건 — 평문은 보관하지 않습니다.`);
      for (const row of rows) {
        const state = row.revoked ? "해지됨" : "사용중";
        const used = row.lastUsedAt ?? "-";
        // 해시 앞부분만 찍는다. 어떤 토큰인지 사람이 가리는 용도이고 검증에는 못 쓴다.
        console.log(
          `  [${state}] ${row.tokenHashPrefix}  ${row.label || "(메모 없음)"}  발급 ${row.createdAt}  마지막사용 ${used}`,
        );
      }
      return 0;
    }

    const token = options.token !== "" ? options.token : await readStdin();
    if (token === "") {
      console.error("해지할 토큰이 없습니다. 인자로 주거나 표준입력으로 넣으세요.");
      return 1;
    }
    await revokeTeamToken(db, token);
    console.log("해지했습니다. 이 토큰으로는 더 이상 접속할 수 없습니다.");
    return 0;
  } finally {
    await db.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
