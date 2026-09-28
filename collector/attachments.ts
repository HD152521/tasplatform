/**
 * 첨부 작업 처리기 — 브라우저가 있는 이 기계에서만 돌 수 있다.
 *
 * 첨부는 supportftp(CrushFTP)에 있고, 거기 로그인은 `redirect.html` 이 **JS 로** 이동시켜
 * 끝난다. 그래서 `fetch` 로는 인증 자체가 안 된다(lib/crushftp.ts 머리말). 웹 컨테이너는
 * 브라우저가 없으므로 attachment_jobs 에 일을 넣고, 이 프로세스가 대신 처리한다.
 *
 * worker 가 자식 프로세스로 부른다(collector/worker.ts). 한 회차에 **큐를 비울 때까지**
 * 돈다 — 브라우저를 한 번 띄우는 데 10초, 이후 케이스 전환은 6초라 여러 건을 모아
 * 처리하는 편이 훨씬 싸다.
 *
 *   node collector/attachments.ts
 */
import { loadEnv } from "../lib/env.ts";
loadEnv();

import { resolve } from "node:path";
import type { BrowserContext } from "playwright";
import { CookieJar } from "./cookieJar.ts";
import { launchBrowser } from "./session.ts";
import { DEFAULT_TEAM_ID, NAV_TIMEOUT_MS, sessionFileForTeam } from "../lib/config.ts";
import { FTP_ORIGIN, UploadError, uploadToCase } from "../lib/crushftp.ts";
import { openDb, type Db } from "../lib/db.ts";
import {
  claimNextJob,
  finishJob,
  hasPendingJobs,
  purgeOldJobs,
  reviveStuckJobs,
  type AttachmentJob,
} from "../lib/attachmentJobs.ts";
import { hydrateTeamSessionFromDb, persistTeamSessionToDb } from "../lib/sessionStore.ts";

/** 한 회차에 처리할 상한. 무한히 돌며 worker 의 다음 일을 막지 않게 한다. */
const MAX_PER_ROUND = 20;

/** 케이스 진입 대기. 실측 첫 진입 10초, 이후 6초. */
const ENTER_TIMEOUT_MS = Math.min(NAV_TIMEOUT_MS, 90_000);

function log(message: string): void {
  console.log(`[attachments] ${message}`);
}

/**
 * 그 케이스로 브라우저를 들여보낸다.
 *
 * 같은 컨텍스트에서 다시 이동하면 다시 묶인다 — logout 이 필요 없다(실측).
 * 돌아온 뒤의 쿠키를 단지에 담아 준다. 이후 명령은 그 쿠키로 보낸다.
 */
async function enterCase(
  context: BrowserContext,
  site: string,
  caseId: number,
): Promise<CookieJar> {
  const page = await context.newPage();
  try {
    await page.goto(`${FTP_ORIGIN}/WebInterface/redirect.html?site=${site}&case=${caseId}`, {
      waitUntil: "networkidle",
      timeout: ENTER_TIMEOUT_MS,
    });
    return new CookieJar((await context.cookies()) as never);
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** 그 케이스의 고객사 번호. 없으면 올릴 위치를 정할 수 없다. */
async function siteOf(db: Db, requestId: number): Promise<string> {
  const row = await db.get<{ party_site_number: string }>(
    "SELECT party_site_number FROM cases WHERE request_id = ?",
    [requestId],
  );
  return (row?.party_site_number ?? "").trim();
}

/** 일 하나. 실패는 던지지 않고 사유 문자열로 돌려준다 — 한 건이 회차를 세우면 안 된다. */
async function runJob(db: Db, context: BrowserContext, job: AttachmentJob): Promise<string> {
  const site = await siteOf(db, job.request_id);
  if (site === "") {
    return "이 케이스의 고객사 번호를 모릅니다. 수집을 한 번 돌린 뒤 다시 시도하세요.";
  }

  const jar = await enterCase(context, site, job.request_id);

  if (job.kind === "upload") {
    const bytes = Buffer.from(job.payload, "base64");
    if (bytes.byteLength === 0) return "올릴 내용이 비어 있습니다.";
    const result = await uploadToCase(jar, {
      site, caseId: job.request_id, fileName: job.file_name, bytes,
    });
    log(`올림 ${job.file_name} (${result.bytes}B, 조각 ${result.chunks})`);
    return "";
  }

  // 다운로드는 다음 단계에서 붙인다. 여기 닿으면 조용히 성공으로 두지 않는다.
  return "다운로드는 아직 준비되지 않았습니다.";
}

async function main(): Promise<void> {
  const db = await openDb();
  try {
    // 처리 중에 죽어 남은 일을 되살린다. 안 그러면 사람은 영원히 "처리 중" 만 본다.
    const revived = await reviveStuckJobs(db);
    if (revived > 0) log(`멈춰 있던 일 ${revived}건을 다시 줄에 세웠습니다.`);

    if (!(await hasPendingJobs(db))) {
      const purged = await purgeOldJobs(db);
      if (purged > 0) log(`끝난 지 오래된 일 ${purged}건을 치웠습니다.`);
      return;
    }

    // 세션 파일이 없을 수 있다(재시작). DB 백업에서 먼저 복원한다.
    await hydrateTeamSessionFromDb(DEFAULT_TEAM_ID, db);
    const sessionFile = resolve(sessionFileForTeam(DEFAULT_TEAM_ID));

    const browser = await launchBrowser(true);
    let done = 0;
    try {
      const context = await browser.newContext({ storageState: sessionFile });
      try {
        for (let i = 0; i < MAX_PER_ROUND; i += 1) {
          const job = await claimNextJob(db);
          if (job === null) break;

          try {
            const error = await runJob(db, context, job);
            await finishJob(db, job.job_id, error === "" ? {} : { error });
            if (error !== "") log(`실패 #${job.job_id}: ${error}`);
          } catch (error) {
            const message = error instanceof UploadError || error instanceof Error
              ? error.message
              : String(error);
            await finishJob(db, job.job_id, { error: message });
            log(`실패 #${job.job_id}: ${message}`);
          }
          done += 1;
        }

        // 브라우저가 받은 쿠키를 저장해 둔다. 다음 회차가 로그인을 아낀다.
        await context.storageState({ path: sessionFile });
      } finally {
        await context.close().catch(() => undefined);
      }
    } finally {
      await browser.close().catch(() => undefined);
    }

    await persistTeamSessionToDb(DEFAULT_TEAM_ID, db).catch((error: unknown) => {
      log(`세션 DB 백업 실패(처리 자체는 끝남): ${error instanceof Error ? error.message : String(error)}`);
    });
    log(`${done}건 처리했습니다.`);
    await purgeOldJobs(db);
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error("[attachments] 실패:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
