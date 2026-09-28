/**
 * 지금 이 컴퓨터가 "쓰기에 쓸 수 있는" 세션을 가지고 있는지 확인한다.
 *
 * 수집과 SR 등록은 서로 다른 세션을 볼 수 있다. 수집기 VM 과 웹은 파일시스템이 다르고,
 * 둘을 잇는 것은 DB 백업(team_session_state) 하나뿐이다. 그래서 화면이 "정상 수집 중"
 * 이라고 하면서 SR 등록만 "세션이 만료되었습니다" 로 막히는 일이 생긴다. 어디가 낡았는지
 * 눈으로 봐야 하므로, 쓰기 경로와 같은 순서로 세 곳을 찍는다.
 *
 * 세션을 쓰는 곳마다 각각 돌린다(수집기 VM, 웹 컨테이너):
 *   node scripts/check-session.ts
 */
import { loadEnv } from "../lib/env.ts";
loadEnv();

import { statSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_TEAM_ID, sessionFileForTeam } from "../lib/config.ts";
import { resolveDbTarget } from "../lib/dbConn.ts";
import { openDb } from "../lib/db.ts";
import { getSessionStatus, sessionStatusFromJson } from "../lib/sessionFile.ts";

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(18)} ${value}`);
}

/** 만료 시각을 "언제까지 / 얼마나 지났나" 로 읽기 쉽게. */
function describe(expiresAt: number | null, expired: boolean): string {
  if (expiresAt === null) return "✗ 만료 시각을 못 읽음(쓸 수 없는 세션)";
  const when = new Date(expiresAt).toISOString();
  const hours = Math.abs(Date.now() - expiresAt) / 3_600_000;
  const gap = hours < 48 ? `${hours.toFixed(1)}시간` : `${(hours / 24).toFixed(1)}일`;
  return expired ? `✗ 만료 (${when}, ${gap} 전)` : `✓ 유효 (${when}, ${gap} 남음)`;
}

/** 접속 대상만 보여준다. 자격증명은 찍지 않는다. */
function describeDbTarget(): string {
  const target = resolveDbTarget();
  if (target.dialect === "sqlite") return `sqlite ${target.file ?? "(기본)"}`;
  try {
    const url = new URL(target.connectionString ?? "");
    return `postgres ${url.hostname}:${url.port || "5432"}${url.pathname} schema=${target.schema ?? "public"}`;
  } catch {
    return `postgres (주소 파싱 실패) schema=${target.schema ?? "public"}`;
  }
}

async function main(): Promise<void> {
  const teamId = DEFAULT_TEAM_ID;

  console.log("[1] 이 프로세스가 보는 DB");
  line("대상", describeDbTarget());
  console.log("\n  수집기와 웹이 여기서 다른 DB 를 가리키면 세션이 절대 공유되지 않는다.");

  console.log("\n[2] 로컬 세션 파일");
  const path = resolve(sessionFileForTeam(teamId));
  line("경로", path);
  const local = getSessionStatus(teamId);
  if (!local.exists) {
    line("상태", "✗ 파일 없음");
  } else {
    line("수정 시각", statSync(path).mtime.toISOString());
    line("SSO 세션", describe(local.expiresAt, local.expired));
    line("기기 신뢰", local.deviceTrusted ? "✓ 있음 (재로그인 시 OTP 생략)" : "✗ 없음 (OTP 필요)");
  }

  console.log("\n[3] DB 백업 (team_session_state)");
  const db = await openDb();
  let backup: { updated_at: string; session_json: string } | undefined;
  try {
    backup = await db.get<{ updated_at: string; session_json: string }>(
      "SELECT updated_at, session_json FROM team_session_state WHERE team_id = ?",
      [teamId],
    );
  } catch (error) {
    line("상태", `✗ 읽기 실패: ${error instanceof Error ? error.message : String(error)}`);
    line("뜻", "백업이 동작하지 않는다. 수집기의 '세션 DB 백업 실패' 로그를 봐야 한다.");
  } finally {
    await db.close();
  }

  let dbExpired = true;
  if (backup === undefined) {
    line("상태", "✗ 행 없음 — 아직 아무도 백업하지 않았다");
  } else {
    line("갱신 시각", backup.updated_at);
    const remote = sessionStatusFromJson(backup.session_json);
    dbExpired = remote.expired;
    line("SSO 세션", describe(remote.expiresAt, remote.expired));
  }

  console.log("\n[4] 판정");
  // 쓰기 경로는 hydrate 후의 상태를 쓴다 — 둘 중 하나라도 살아 있으면 쓸 수 있다.
  if (!local.expired) {
    console.log("\n  ✓ 로컬 세션이 살아 있다. SR 등록·답변이 지금 된다.");
    return;
  }
  if (!dbExpired) {
    console.log("\n  ✓ 로컬은 만료됐지만 DB 백업이 살아 있다. hydrate 가 이걸 끌어와 쓴다.");
    console.log("    그래도 막히면 이 프로세스의 코드가 낡은 것이다(hydrate 가 만료 파일을 안 바꾸는 버전).");
    return;
  }
  console.log("\n  ✗ 로컬도 DB 도 만료됐다. 쓰기는 지금 불가능하다.");
  console.log("    Playwright 가 있는 곳(수집기 VM)에서 로그인해 DB 까지 올린다:");
  console.log("      npm run refresh");
  console.log(`    SSO 세션은 약 12시간이다 — 로그인 직후에 등록해야 한다.`);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error("확인 실패:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
