/**
 * 첨부 작업 처리기 — 브라우저가 있는 이 기계에서만 돌 수 있다.
 *
 * 첨부는 supportftp(CrushFTP)에 있고, 거기 로그인은 `redirect.html` 이 **JS 로** 이동시켜
 * 끝난다. 그래서 `fetch` 로는 인증 자체가 안 된다(lib/crushftp.ts 머리말). 웹 컨테이너는
 * 브라우저가 없으므로 attachment_jobs 에 일을 넣고, 이 프로세스가 대신 처리한다.
 *
 * worker 가 자식 프로세스로 부른다(collector/worker.ts). 한 회차에 **큐를 비울 때까지**
 * 돈다 — 브라우저를 한 번 띄우는 데 10초, 케이스 전환이 6초라 여러 건을 모아 처리하는
 * 편이 훨씬 싸다. 같은 케이스가 이어지면 전환도 하지 않는다(jarFor).
 *
 *   node collector/attachments.ts
 */
import { loadEnv } from "../lib/env.ts";
loadEnv();

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BrowserContext } from "playwright";
import { CookieJar } from "./cookieJar.ts";
import { launchBrowser } from "./session.ts";
import { DEFAULT_TEAM_ID, NAV_TIMEOUT_MS, sessionFileForTeam } from "../lib/config.ts";
import {
  FTP_ORIGIN,
  UploadError,
  fileUrlFor,
  parseFilePath,
  uploadToCase,
} from "../lib/crushftp.ts";
import { openDb, type Db } from "../lib/db.ts";
import {
  claimNextJob,
  finishJob,
  hasPendingJobs,
  purgeOldJobs,
  reviveStuckJobs,
  type AttachmentJob,
} from "../lib/attachmentJobs.ts";
import { cookiesOnlyState, type CookiesOnlyState } from "../lib/attachSessionState.ts";
import { hydrateTeamSessionFromDb, persistTeamSessionToDb } from "../lib/sessionStore.ts";

/** 한 회차에 처리할 상한. 무한히 돌며 worker 의 다음 일을 막지 않게 한다. */
const MAX_PER_ROUND = 20;

/** 케이스 진입 대기. 실측 첫 진입 10초, 이후 6초. */
const ENTER_TIMEOUT_MS = Math.min(NAV_TIMEOUT_MS, 90_000);

function log(message: string): void {
  console.log(`[attachments] ${message}`);
}

/**
 * 컨텍스트를 만들 때 Playwright 에 넘길 세션 상태.
 *
 * 기본은 **쿠키만** 싣는다 — origins(localStorage) 복원이 컨텍스트 생성에 11.6초를
 * 더하는데 첨부에는 필요 없다. 근거와 규칙은 lib/attachSessionState.ts 에 있다.
 *
 * `SR_ATTACH_FULL_SESSION=1` 이면 옛 동작(세션 파일을 그대로 넘겨 origins 까지 복원)
 * 으로 되돌린다. 혹시 이 판단이 틀려 첨부가 줄줄이 실패하면 그 한 줄로 빠져나온다.
 */
async function sessionStateFor(sessionFile: string): Promise<string | CookiesOnlyState> {
  if (process.env.SR_ATTACH_FULL_SESSION === "1") return sessionFile;
  let raw: string;
  try {
    raw = await readFile(sessionFile, "utf8");
  } catch (error) {
    // 못 읽으면 경로를 그대로 넘긴다. Playwright 가 같은 파일을 읽고 더 분명한 오류를
    // 낸다 — 여기서 삼켜 "세션 없음" 으로 보이게 하지 않는다.
    log(`세션 파일을 직접 읽지 못해 origins 생략을 건너뜁니다: ${
      error instanceof Error ? error.message : String(error)}`);
    return sessionFile;
  }
  return cookiesOnlyState(raw) ?? sessionFile;
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

/**
 * 지금 들어가 있는 케이스. 한 회차 안에서만 산다.
 *
 * `enterCase` 한 번이 **6초**다. 한 케이스에 파일 세 개를 올리면 그 6초를 세 번 낸다 —
 * 같은 케이스인데 들어갔다 나올 이유가 없다. 바뀔 때만 다시 들어간다.
 *
 * 실패하면 비운다. 세션이 끊겼는데 끊긴 단지를 계속 쓰면 남은 일이 줄줄이 실패한다.
 */
interface CaseSession {
  readonly site: string;
  readonly caseId: number;
  readonly jar: CookieJar;
}

/** 그 케이스의 단지. 이미 그 케이스에 있으면 들어가지 않는다. */
async function jarFor(
  context: BrowserContext,
  held: { current: CaseSession | null },
  site: string,
  caseId: number,
): Promise<CookieJar> {
  const current = held.current;
  if (current !== null && current.site === site && current.caseId === caseId) {
    return current.jar;
  }
  const jar = await enterCase(context, site, caseId);
  held.current = { site, caseId, jar };
  return jar;
}

/** 그 케이스의 고객사 번호. 없으면 올릴 위치를 정할 수 없다. */
async function siteOf(db: Db, requestId: number): Promise<string> {
  const row = await db.get<{ party_site_number: string }>(
    "SELECT party_site_number FROM cases WHERE request_id = ?",
    [requestId],
  );
  return (row?.party_site_number ?? "").trim();
}

/**
 * 일 하나의 결과.
 *
 * 받아온 내용을 여기에 실어 **호출부가 한 번만** finishJob 을 부르게 한다.
 * 처리 쪽에서도 부르면 그 뒤 호출이 payload 를 지운다.
 */
interface JobOutcome {
  /** 빈 문자열이면 성공. */
  readonly error: string;
  /** 다운로드가 받아온 내용(base64). */
  readonly payload?: string;
}

/** 일 하나. 실패는 던지지 않고 사유로 돌려준다 — 한 건이 회차를 세우면 안 된다. */
async function runJob(
  db: Db,
  context: BrowserContext,
  held: { current: CaseSession | null },
  job: AttachmentJob,
): Promise<JobOutcome> {
  if (job.kind === "download") return await runDownload(db, context, held, job);

  const site = await siteOf(db, job.request_id);
  if (site === "") {
    return { error: "이 케이스의 고객사 번호를 모릅니다. 수집을 한 번 돌린 뒤 다시 시도하세요." };
  }

  const jar = await jarFor(context, held, site, job.request_id);

  if (job.kind === "upload") {
    const bytes = Buffer.from(job.payload, "base64");
    if (bytes.byteLength === 0) return { error: "올릴 내용이 비어 있습니다." };
    const result = await uploadToCase(jar, {
      site, caseId: job.request_id, fileName: job.file_name, bytes,
    });
    log(`올림 ${job.file_name} (${result.bytes}B, 조각 ${result.chunks})`);
    return { error: "" };
  }

  return { error: "알 수 없는 작업 종류입니다." };
}

/**
 * 첨부 하나를 받아 온다.
 *
 * 저장된 doc_path 는 파일이 아니라 **JS 로 이동시키는 페이지**다. 그래서 그 주소를
 * 그대로 받으면 HTML 이 온다 — 첨부 다운로드가 안 되던 이유다. filePath 를 떼어
 * 실물 위치로 바로 간다.
 *
 * 요청은 브라우저 컨텍스트로 보낸다(context.request). 쿠키와 리다이렉트를 브라우저가
 * 알아서 다루고, 우리가 세션을 다시 흉내 낼 필요가 없다.
 */
async function runDownload(
  db: Db,
  context: BrowserContext,
  held: { current: CaseSession | null },
  job: AttachmentJob,
): Promise<JobOutcome> {
  const row = await db.get<{ doc_path: string; doc_name: string }>(
    "SELECT doc_path, doc_name FROM attachments WHERE document_id = ?",
    [job.document_id],
  );
  if (row === undefined) return { error: "첨부를 찾지 못했습니다." };

  const ref = parseFilePath(row.doc_path);
  if (ref === null) return { error: "첨부 주소를 읽지 못했습니다." };

  // 세션을 그 케이스로 묶어야 파일이 보인다. 첨부에 적힌 케이스를 쓴다 —
  // 작업 행의 케이스와 다를 수 있다(옮겨진 케이스 등).
  await jarFor(context, held, ref.site, ref.caseId);

  const response = await context.request.get(fileUrlFor(ref), { timeout: ENTER_TIMEOUT_MS });
  // 404·403 은 흔하고 뜻이 다르다. Broadcom 이 오래된 업로드를 치우므로, 우리 DB 에는
  // 남아 있지만 서버에는 없는 첨부가 많다. 그걸 "거부" 로 뭉치면 사람이 세션을 의심한다.
  if (response.status() === 404) {
    return { error: "이 첨부는 서버에서 삭제되었습니다. 담당자에게 다시 요청해야 합니다." };
  }
  if (response.status() === 403) {
    return { error: "이 첨부에 접근할 수 없습니다. 오래된 케이스는 첨부가 닫힙니다." };
  }
  if (!response.ok()) {
    return { error: `첨부 서버가 거부했습니다 (HTTP ${response.status()}).` };
  }

  const type = (response.headers()["content-type"] ?? "").toLowerCase();
  const body = await response.body();
  // 로그인 화면이 200 으로 오는 경우가 있다. 그걸 파일로 저장하면
  // "사용할 수 없는 파일" 이 된다 — 지금까지 겪던 그 증상이다.
  if (type.includes("text/html")) {
    return { error: "파일 대신 로그인 화면이 왔습니다. 세션을 다시 만들어야 합니다." };
  }
  if (body.byteLength === 0) return { error: "받아온 내용이 비어 있습니다." };

  log(`받음 ${row.doc_name} (${body.byteLength}B)`);
  return { error: "", payload: body.toString("base64") };
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
      const context = await browser.newContext({
        storageState: await sessionStateFor(sessionFile) as never,
      });
      // 들어가 있는 케이스. 같은 케이스가 이어지면 재진입(6초)을 아낀다.
      const held: { current: CaseSession | null } = { current: null };
      try {
        for (let i = 0; i < MAX_PER_ROUND; i += 1) {
          const job = await claimNextJob(db);
          if (job === null) break;

          try {
            const outcome = await runJob(db, context, held, job);
            if (outcome.error !== "") held.current = null;
            await finishJob(db, job.job_id, outcome.error === ""
              ? { payload: outcome.payload }
              : { error: outcome.error });
            if (outcome.error !== "") log(`실패 #${job.job_id}: ${outcome.error}`);
          } catch (error) {
            // 던지고 나온 뒤에는 세션 상태를 믿을 수 없다. 다음 일은 다시 들어간다.
            held.current = null;
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
