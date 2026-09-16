/**
 * 실제 쓰기/요약 함수 배선 (mcp/writeTools.ts·mcp/readTools.ts 가 주입받는 WriteDeps/
 * GetSummaryDeps 의 진짜 구현).
 *
 * 여기서 lib/reply.ts·lib/createCase.ts·lib/refreshCase.ts·lib/summary.ts 를 값으로
 * 불러온다 — 전부 "server-only" 마커가 붙어 있어 이 파일은 반드시
 * `node --conditions=react-server` 로 실행되는 프로세스에서만 불러와야 한다
 * (package.json 의 "mcp" 스크립트가 그렇게 띄운다). 일반 `node --test` 로 이 파일을
 * 불러오면 즉시 throw 한다 — 그래서 테스트는 이 파일을 불러오지 않고, 대신
 * mcp/writeTools.ts·mcp/readTools.ts 를 가짜 deps 로 직접 단위테스트한다.
 */
import { fetchClient } from "../collector/httpClient.ts";
import { sessionFileForTeam } from "../lib/config.ts";
import { createCase } from "../lib/createCase.ts";
import { hasTeamSession } from "../lib/requestAudit.ts";
import { refreshCaseThreads, refreshOpenCases } from "../lib/refreshCase.ts";
import { postReply } from "../lib/reply.ts";
import { hydrateTeamSessionFromDb, persistTeamSessionToDb } from "../lib/sessionStore.ts";
import { getSummary } from "../lib/summary.ts";
import type { GetSummaryDeps } from "./readTools.ts";
import type { WriteDeps } from "./writeTools.ts";

export const writeDeps: WriteDeps = {
  hasTeamSession,
  fetchClient,
  sessionFileForTeam,
  postReply,
  createCase,
  refreshCaseThreads,
  refreshOpenCases,
  hydrateSession: hydrateTeamSessionFromDb,
  persistSession: persistTeamSessionToDb,
};

export const summaryDeps: GetSummaryDeps = {
  getSummary,
};
