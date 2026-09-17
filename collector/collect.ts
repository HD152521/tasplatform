/**
 * 수집 파이프라인.
 *
 * 진행중 케이스는 전부, 종료 케이스는 최근 BACKFILL_MONTHS 개월 이내 것만 가져온다.
 * 실패는 반드시 runs 에 상태로 남긴다. 특히 session_expired 를 '새 답변 0건'과
 * 절대 같게 취급하지 않는다.
 */
import { loadEnv } from "../lib/env.ts";
loadEnv();

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  ALLOWED_PARTY_SITES,
  API_HEADERS,
  API_ORIGIN,
  CREDENTIALS,
  DEFAULT_TEAM_ID,
  REQUEST_DELAY_MS,
  sessionFileForTeam,
} from "../lib/config.ts";
import { filterAllowedParties } from "../lib/partyFilter.ts";
import { browserClient, fetchClient, type ApiClient } from "./httpClient.ts";
import { loginContextOptions } from "../lib/browserIdentity.ts";
import { OtpRequiredError, performCredentialLogin, saveSession } from "./autoLogin.ts";
import { isoNow } from "../lib/dates.ts";
import {
  finishRun, getExistingCaseIndex, getKnownThreadIds, inTransaction,
  openDb, startRun, upsertAttachment, upsertCase, upsertThread, type Db,
} from "../lib/db.ts";
import {
  dedupeReplies, htmlToText, selectChangedCases, selectNewReplies,
} from "../lib/diff.ts";
import type { SearchResultItem } from "../lib/types.ts";
import { fetchCaseDescription, fetchCaseList, fetchThreads, type CaseDetail } from "./api.ts";
import { toAttachmentRows, toCaseRow, toThreadRow } from "../lib/rowMappers.ts";
import { acquireLock } from "./lock.ts";
import { REPLY_LIMIT, formatFailure, formatReplies, hasWebhook, send } from "../lib/notify.ts";
import { summarizeReplies } from "../lib/replySummary.ts";
import {
  SessionExpiredError, SessionMissingError,
  ensureSessionValid, launchBrowser, openSavedSession, persistSession,
} from "./session.ts";
import { hydrateTeamSessionFromDb, persistTeamSessionToDb } from "../lib/sessionStore.ts";

const DRY_RUN = process.argv.includes("--dry-run");

/**
 * 브라우저 로그인을 끌지 여부(SR_DISABLE_BROWSER_LOGIN).
 *
 * TAS 컨테이너는 브라우저를 돌릴 환경이 못 된다 — 디스크(2G)가 chromium /tmp 추출·프로필로
 * 금세 차서(ENOSPC) 포털 SPA 가 "Loading..." 에서 멈춰 로그인 페이지로 넘어가지도 못한다.
 * 게다가 15분마다 재로그인을 시도하며 디스크를 채우는 악순환이 된다. 그래서 컨테이너에서는
 * 이 값을 켜서 브라우저를 아예 띄우지 않고, 세션이 만료되면 즉시 '재시딩 필요'로 알린다.
 * 로그인/시딩은 브라우저가 되는 로컬·VM 에서 하고 DB 로 심는다(fast path 로 수집).
 */
function browserLoginDisabled(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.SR_DISABLE_BROWSER_LOGIN ?? "").trim());
}

interface NewReply {
  /** 알림에서 케이스로 바로 갈 링크를 만들 때 쓴다. */
  requestId: number;
  caseLabel: string;
  subject: string;
  author: string;
  when: string;
  preview: string;
  /** 요약에 넘길 본문 전문. preview 는 콘솔 출력용이라 너무 짧다. */
  body: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 진행중 전체 + 종료 케이스(포털의 LAST_3_MONTH 범위).
 *
 * 두 조회는 payload 가 다르다. 종료분은 closedOn 날짜 조건을 쓰며,
 * 범위 토큰이 포털 쪽에 LAST_3_MONTH 로 박혀 있어 우리가 날짜를 계산하지 않는다.
 */
async function gatherCases(client: ApiClient): Promise<SearchResultItem[]> {
  const open = await fetchCaseList(client, { scope: "open" });
  await sleep(REQUEST_DELAY_MS);
  const closed = await fetchCaseList(client, { scope: "closed" });

  const merged = new Map<number, SearchResultItem>();
  for (const item of open) merged.set(item.requestId, item);
  for (const item of closed) merged.set(item.requestId, item);
  // 우리 담당 고객사(사이트) 케이스만 남긴다 — 계정이 다른 고객사(KB Life 등) SR 도
  // 함께 보여줘서, partySiteNumber 화이트리스트로 거른다. 미설정이면 전부 통과(기존 동작).
  return filterAllowedParties([...merged.values()], ALLOWED_PARTY_SITES);
}

/**
 * 수집 한 회차가 쓰는 API 통로.
 * 빠른 경로(fetch)든 폴백(브라우저)이든 이 모양으로 감싸 쓴다.
 */
interface CollectSession {
  client: ApiClient;
  /** 회전된 쿠키를 세션 파일에 반영한다. */
  persist: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * 빠른 경로: 저장된 쿠키만으로 API 를 두드려 본다. 브라우저를 띄우지 않는다.
 *
 * 실측상 브라우저 경로는 실행 33초 중 30초를 브라우저 수명주기에 쓴다
 * (대부분 storageState 의 origin 탐색). 세션이 멀쩡한 대부분의 회차에서는
 * 그 비용이 통째로 낭비다. 200 이 아니면 null 을 돌려 폴백하게 둔다.
 */
async function acquireFastSession(teamId: string = DEFAULT_TEAM_ID): Promise<CollectSession | null> {
  const sessionFile = sessionFileForTeam(teamId);
  if (!existsSync(resolve(sessionFile))) return null;

  let http;
  try {
    http = fetchClient(sessionFile);
  } catch {
    return null; // 세션 파일이 깨졌으면 폴백이 판단한다
  }

  const response = await http
    .get(`${API_ORIGIN}/account_service/issessionvalid`, { headers: API_HEADERS })
    .catch(() => null);
  if (response === null || response.status() !== 200) return null;

  const persist = async (): Promise<void> => {
    http.persist();
  };
  return { client: http, persist, close: persist };
}

/**
 * 폴백: 브라우저로 세션을 확보한다.
 *
 * 저장된 세션이 유효하면 그대로 쓰고, 만료됐으면 계정이 있을 때 한 번만 재로그인한다.
 * 재로그인도 실패하면 예외를 그대로 올려 'session_expired' 로 기록되게 한다.
 * (조용히 빈 결과를 돌려주면 '새 답변 없음'과 구분되지 않는다)
 */
async function acquireBrowserSession(
  teamId: string = DEFAULT_TEAM_ID,
): Promise<Awaited<ReturnType<typeof openSavedSession>>> {
  // 컨테이너 등 브라우저를 못 돌리는 환경에서는 아예 띄우지 않는다(디스크 ENOSPC·무한 재시도 방지).
  // fast path(browserless)로 세션이 살아 있는 동안만 수집하고, 만료되면 재시딩을 요청한다.
  if (browserLoginDisabled()) {
    throw new SessionExpiredError(
      "세션이 만료되었고 이 환경에서는 브라우저 로그인이 꺼져 있습니다(SR_DISABLE_BROWSER_LOGIN).\n" +
        "  브라우저가 되는 로컬/VM 에서 'npm run login' → 'npm run seed:session' 으로 세션을 다시 심으세요.",
    );
  }
  try {
    const existing = await openSavedSession(teamId);
    try {
      await ensureSessionValid(existing.context);
      return existing;
    } catch (error) {
      await existing.close();
      if (CREDENTIALS === null) throw error;
      console.log("세션이 만료되어 저장된 계정으로 재로그인합니다.");
    }
  } catch (error) {
    if (CREDENTIALS === null) throw error;
    if (!(error instanceof SessionMissingError)) throw error;
    console.log("세션이 없어 저장된 계정으로 로그인합니다.");
  }

  const browser = await launchBrowser(true);
  // 로그인이 실패하면 반드시 브라우저를 닫는다.
  //
  // 안 닫으면 Node 가 종료하지 못하고 매달린 채 살아남는다. 실측 사고 2건:
  // OTP 를 요구받아 로그인이 실패한 회차가 4시간 넘게 죽지 않고 락과
  // collect.log 핸들을 쥐고 있어, 이후 모든 스케줄 실행이 첫 줄부터 실패했다.
  // 작업 스케줄러는 그동안 계속 '결과 0'으로 보고했다.
  try {
    // 기기 신뢰 쿠키를 넘겨야 무인 재로그인이 OTP 에 막히지 않는다.
    const context = await browser.newContext(loginContextOptions(browser, teamId));
    const page = await context.newPage();
    await performCredentialLogin(page);
    await page.close().catch(() => undefined);
    await saveSession(context, teamId);

    const session = {
      browser,
      context,
      close: async () => {
        await browser.close().catch(() => undefined);
      },
    };
    await ensureSessionValid(session.context);
    return session;
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
}

/** 빠른 경로를 먼저 시도하고, 안 되면 브라우저로 넘어간다. */
async function acquireSession(teamId: string = DEFAULT_TEAM_ID): Promise<CollectSession> {
  const fast = await acquireFastSession(teamId);
  if (fast !== null) return fast;

  const browser = await acquireBrowserSession(teamId);
  return {
    client: browserClient(browser.context.request),
    persist: () => persistSession(browser.context, teamId),
    close: () => browser.close(),
  };
}

async function main(): Promise<void> {
  const release = acquireLock();
  if (release === null) {
    console.log("다른 수집기가 이미 실행 중입니다. 이번 회차는 건너뜁니다.");
    return;
  }

  const db = await openDb();
  const runId = await startRun(db);
  let session: CollectSession | null = null;

  try {
    // TAS 재시작으로 로컬 세션/기기 파일이 날아갔을 수 있다 — DB 백업에서 먼저 복원한다.
    // (파일이 있으면 최신으로 덮어써 DB 를 정본으로 삼는다.)
    await hydrateTeamSessionFromDb(DEFAULT_TEAM_ID, db);
    session = await acquireSession();
    // 접속하는 순간 서버가 세션 쿠키를 회전시킨다.
    // 갱신분을 저장하지 않으면 파일에 남은 옛 쿠키가 무효화되어 다음 실행이 실패한다.
    // 이는 데이터 쓰기가 아니므로 dry-run 에서도 반드시 저장한다.
    await session.persist();

    const cases = await gatherCases(session.client);
    const known = await getExistingCaseIndex(db);
    const changes = selectChangedCases(cases, known);
    const now = isoNow();

    const replies: NewReply[] = [];
    const details = new Map<number, CaseDetail>();
    let newThreadCount = 0;

    for (const change of changes) {
      const threads = await fetchThreads(session.client, change.item.requestId);
      const knownIds = await getKnownThreadIds(db, change.item.requestId);
      // DB에는 원본 전부를 저장하고, 알림 판정에서만 내부/외부 중복을 합친다.
      const fresh = dedupeReplies(selectNewReplies(threads, knownIds));
      newThreadCount += fresh.length;

      for (const thread of fresh) {
        replies.push({
          requestId: change.item.requestId,
          caseLabel: change.item.requestIdFormatted,
          subject: change.item.requestDesc,
          author: thread.createdUserUnitName,
          when: thread.resDateVal,
          preview: htmlToText(thread.resDesc ?? "").slice(0, 120),
          body: htmlToText(thread.resDesc ?? ""),
        });
      }

      // 케이스 본문은 변경된 건에 대해서만 가져온다.
      details.set(change.item.requestId, await fetchCaseDescription(session.client, change.item.requestId));

      if (!DRY_RUN) {
        await inTransaction(db, async (tx) => {
          for (const thread of threads) {
            await upsertThread(tx, toThreadRow(thread, now));
            for (const doc of toAttachmentRows(thread, now)) await upsertAttachment(tx, doc);
          }
        });
      }
      await sleep(REQUEST_DELAY_MS);
    }

    if (!DRY_RUN) {
      // 변경이 0건이어도 292행을 매번 다시 쓴다. 트랜잭션으로 묶어야 한다.
      await inTransaction(db, async (tx) => {
        for (const item of cases) {
          await upsertCase(tx, toCaseRow(item, now, details.get(item.requestId)));
        }
      });
    }
    // 수집 도중에도 쿠키가 갱신되므로 마지막 상태를 한 번 더 저장한다.
    await session.persist();
    // 회전된 세션·기기신뢰를 DB 로 백업한다(재시작 후 hydrate 로 복원). 실패해도 수집은 성공.
    try {
      await persistTeamSessionToDb(DEFAULT_TEAM_ID, db);
    } catch (error) {
      console.error("세션 DB 백업 실패(수집 자체는 성공):", error instanceof Error ? error.message : String(error));
    }

    await finishRun(db, runId, {
      status: "success",
      casesSeen: cases.length,
      casesChanged: changes.length,
      newThreads: newThreadCount,
      sessionState: "valid",
    });

    report(cases.length, changes.length, replies);
    await announceReplies(replies);
  } catch (error) {
    const expired =
      error instanceof SessionExpiredError ||
      error instanceof SessionMissingError ||
      error instanceof OtpRequiredError;
    const message = error instanceof Error ? error.message : String(error);

    await finishRun(db, runId, {
      status: expired ? "session_expired" : "failed",
      sessionState: expired ? "expired" : "unknown",
      error: message,
    });

    console.error(expired ? "\n[세션 문제] " + message : "\n[수집 실패] " + message);
    console.error("주의: 이번 회차는 조회하지 못했습니다. '새 답변 없음'이 아닙니다.");
    // 콘솔에만 남기면 아무도 모른다. 조용히 멈춘 것이 이 도구의 최악의 실패다.
    await announceFailure(db, runId, expired ? "session" : "failed", message);
    process.exitCode = 1;
  } finally {
    await session?.close();
    db.close();
    release();
  }
}

/**
 * 새 답변을 메신저로 알린다. 웹훅이 없으면 조용히 넘어간다.
 *
 * 요점 요약을 붙여 보낸다. 요약이 실패하면 원문 발췌로 떨어지되
 * 알림 자체는 반드시 보낸다 — 알림이 사라지는 쪽이 훨씬 나쁘다.
 * 본문에 실리는 앞 REPLY_LIMIT 건만 요약한다. 나머지는 수만 밝히므로 부를 필요가 없다.
 */
async function announceReplies(replies: readonly NewReply[]): Promise<void> {
  if (replies.length === 0 || !hasWebhook()) return;

  const summaries = await summarizeReplies(
    replies.slice(0, REPLY_LIMIT).map((reply) => ({
      caseLabel: reply.caseLabel,
      subject: reply.subject,
      author: reply.author,
      body: reply.body,
    })),
    (message) => console.error(`  요약: ${message}`),
  );
  const byAi = summaries.filter((summary) => summary.source === "ai").length;
  console.log(`  요약 ${summaries.length}건 (AI ${byAi} / 발췌 ${summaries.length - byAi})`);

  const result = await send(formatReplies(
    replies.map((reply, index) => ({
      caseLabel: reply.caseLabel,
      subject: reply.subject,
      requestId: reply.requestId,
      summary: summaries[index]?.text,
    })),
  ));
  if (!result.ok) console.error(`알림 전송 실패: ${result.detail}`);
}

/**
 * 수집 실패를 알린다.
 *
 * 15분마다 도는데 매번 보내면 도배가 된다. 직전 회차도 같은 상태였다면
 * 이미 알린 것이므로 건너뛴다 — 상태가 바뀌는 순간에만 알린다.
 */
async function announceFailure(
  db: Db,
  runId: number,
  kind: "session" | "failed",
  message: string,
): Promise<void> {
  if (!hasWebhook()) return;
  const status = kind === "session" ? "session_expired" : "failed";
  // 끝까지 못 간 회차(startRun 이 넣어 둔 'failed' 자리표)는 알림을 보낸 적이 없으므로
  // 직전 회차로 세지 않는다. 이걸 빼면 중단된 회차 뒤의 진짜 첫 실패가 묻힌다.
  const rows = (await db.all(
    `SELECT status FROM runs
      WHERE run_id < ? AND finished_at IS NOT NULL
      ORDER BY run_id DESC LIMIT 1`,
    [runId],
  )) as Array<{ status: string }>;
  if (rows[0]?.status === status) return;

  const result = await send(formatFailure(kind, message));
  if (!result.ok) console.error(`알림 전송 실패: ${result.detail}`);
}

function report(seen: number, changed: number, replies: readonly NewReply[]): void {
  console.log("");
  console.log(`수집 완료${DRY_RUN ? " (dry-run: DB 미반영)" : ""}`);
  console.log(`  케이스 ${seen}건 조회 / 변경 ${changed}건`);
  console.log(`  새 답변 ${replies.length}건`);
  for (const r of replies) {
    console.log("");
    console.log(`  [${r.caseLabel}] ${r.subject}`);
    console.log(`     ${r.author} · ${r.when}`);
    console.log(`     ${r.preview}`);
  }
}

main().catch((error: unknown) => {
  console.error("예기치 못한 오류:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
