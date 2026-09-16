/**
 * 세션 시딩 CLI.
 *
 * 로컬/VM 에서 브라우저 로그인으로 만든 session.json·device.json 을 대상 DB(TAS 는 Postgres)
 * 의 team_session_state 에 업로드한다. TAS 컨테이너엔 브라우저가 없어 로그인할 수 없으므로,
 * 여기서 심어 둔 세션을 수집기가 hydrateTeamSessionFromDb 로 복원해 쓴다.
 *
 *   node scripts/seed-session.ts            기본 팀(DEFAULT_TEAM_ID)
 *   node scripts/seed-session.ts <team-id>  특정 팀
 *
 * 업로드만 한다(hydrate 안 함). 세션 쿠키·기기 토큰·DB 접속정보는 절대 출력하지 않는다.
 */
import { loadEnv } from "../lib/env.ts";
loadEnv();

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertValidTeamId,
  DEFAULT_TEAM_ID,
  deviceFileForTeam,
  sessionFileForTeam,
} from "../lib/config.ts";
import { openDb, type Db } from "../lib/db.ts";
import { closeAllPools } from "../lib/dbCore.ts";
import { persistTeamSessionToDb } from "../lib/sessionStore.ts";

export interface SeedResult {
  /** 로컬 파일이 있어 DB 에 저장했는지. false 면 심을 게 없었다는 뜻(no-op). */
  readonly uploaded: boolean;
  /** 대상 DB 방언. 업로드하지 않았고 db 도 안 열었으면 null. */
  readonly dialect: Db["dialect"] | null;
}

/**
 * 세션 시딩의 순수 로직. CLI(argv/exit)와 분리해 테스트 가능하게 뽑았다.
 *
 * 로컬 세션/기기 파일이 하나도 없으면 DB 를 열지도 않고 no-op 으로 알린다(uploaded=false).
 * 파일이 있으면 기존 persistTeamSessionToDb 로 DB 에 upsert 한다(중복 구현하지 않는다).
 * 넘겨받은 db 가 없을 때만 스스로 openDb/close 한다(테스트는 임시 SQLite db 를 주입).
 *
 * 반환값에는 메타(업로드 여부·방언)만 담는다 — 세션 내용은 절대 싣지 않는다.
 */
export async function seedSession(teamId: string, existing?: Db): Promise<SeedResult> {
  assertValidTeamId(teamId);

  const hasLocalFiles =
    existsSync(resolve(sessionFileForTeam(teamId))) ||
    existsSync(resolve(deviceFileForTeam(teamId)));

  if (!hasLocalFiles) {
    // 심을 게 없으면 DB 접속 비용도 들이지 않는다.
    return { uploaded: false, dialect: existing ? existing.dialect : null };
  }

  const db = existing ?? (await openDb());
  try {
    await persistTeamSessionToDb(teamId, db);
    return { uploaded: true, dialect: db.dialect };
  } finally {
    if (!existing) await db.close();
  }
}

async function main(): Promise<void> {
  const teamId = process.argv[2]?.trim() || DEFAULT_TEAM_ID;

  try {
    assertValidTeamId(teamId);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const result = await seedSession(teamId);

  if (!result.uploaded) {
    console.error(
      `팀 ${teamId} 의 로컬 세션 파일이 없습니다.\n` +
        `먼저 로컬/VM 에서 브라우저로 로그인해 세션을 만든 뒤 다시 실행하세요: npm run login`,
    );
    process.exitCode = 1;
    return;
  }

  // 성공: 메타만 출력한다. 세션 쿠키·토큰·접속문자열은 절대 찍지 않는다.
  console.log(`팀 ${teamId} 세션을 DB 에 저장했습니다. (대상: ${result.dialect})`);
}

// 진입점으로 직접 실행될 때만 main 을 돈다. 테스트가 seedSession 을 import 할 때는
// argv/exit 부작용이 없어야 하므로 여기서 가드한다.
const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  main()
    .catch((error: unknown) => {
      // error.message 만 노출한다 — pg 에러 등에 접속정보가 섞일 여지를 최소화한다.
      console.error("세션 시딩 실패:", error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      // pg 풀을 닫아 프로세스가 매달리지 않게 한다.
      await closeAllPools();
      process.exit(process.exitCode ?? 0);
    });
}
