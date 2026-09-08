/**
 * 수집 파이프라인.
 *
 * 진행중 케이스는 전부, 종료 케이스는 최근 BACKFILL_MONTHS 개월 이내 것만 가져온다.
 * 실패는 반드시 runs 에 상태로 남긴다. 특히 session_expired 를 '새 답변 0건'과
 * 절대 같게 취급하지 않는다.
 */
import { loadEnv } from "../lib/env.ts";
loadEnv();

import type { BrowserContext } from "playwright";
import { CREDENTIALS, REQUEST_DELAY_MS } from "../lib/config.ts";
import { OtpRequiredError, performCredentialLogin, saveSession } from "./autoLogin.ts";
import { isoNow, toEpochMs } from "../lib/dates.ts";
import {
  finishRun, getExistingCaseIndex, getKnownThreadIds,
  openDb, startRun, upsertAttachment, upsertCase, upsertThread,
} from "../lib/db.ts";
import {
  dedupeReplies, htmlToText, isOurThread, selectChangedCases, selectNewReplies,
} from "../lib/diff.ts";
import type { AttachmentRow, RequestThreadVo, SearchResultItem } from "../lib/types.ts";
import { fetchCaseDescription, fetchCaseList, fetchThreads, type CaseDetail } from "./api.ts";
import { acquireLock } from "./lock.ts";
import { formatFailure, formatReplies, hasWebhook, send } from "../lib/notify.ts";
import {
  SessionExpiredError, SessionMissingError,
  ensureSessionValid, launchBrowser, openSavedSession, persistSession,
} from "./session.ts";

const DRY_RUN = process.argv.includes("--dry-run");

interface NewReply {
  /** 알림에서 케이스로 바로 갈 링크를 만들 때 쓴다. */
  requestId: number;
  caseLabel: string;
  subject: string;
  author: string;
  when: string;
  preview: string;
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
async function gatherCases(context: BrowserContext): Promise<SearchResultItem[]> {
  const open = await fetchCaseList(context, { scope: "open" });
  await sleep(REQUEST_DELAY_MS);
  const closed = await fetchCaseList(context, { scope: "closed" });

  const merged = new Map<number, SearchResultItem>();
  for (const item of open) merged.set(item.requestId, item);
  for (const item of closed) merged.set(item.requestId, item);
  return [...merged.values()];
}

function toCaseRow(
  item: SearchResultItem,
  now: string,
  detail?: CaseDetail,
) {
  const descriptionHtml = detail?.description ?? "";
  return {
    request_id: item.requestId,
    request_id_formatted: item.requestIdFormatted ?? String(item.requestId),
    subject: item.requestDesc ?? "",
    status: item.statusAliasName ?? "",
    priority: item.priorityName ?? "",
    category: item.subCategoryName ?? "",
    party_name: item.partyName ?? "",
    party_site_number: item.partySiteNumber ?? "",
    created_on: item.createdOn ?? "",
    created_on_ms: toEpochMs(item.createdOn),
    last_updated: item.lastUpdated ?? "",
    last_updated_ms: toEpochMs(item.lastUpdated),
    last_fetched_at: now,
    raw_json: JSON.stringify(item),
    description_html: descriptionHtml,
    description_text: htmlToText(descriptionHtml),
    case_version: detail?.version ?? null,
    product_id: detail?.productId ?? null,
    product_name: detail?.productName ?? "",
    component_id: detail?.componentId ?? null,
    component_name: detail?.componentName ?? "",
  };
}

function toThreadRow(thread: RequestThreadVo, now: string) {
  const html = thread.resDesc ?? "";
  return {
    thread_id: thread.requestThreadId,
    request_id: thread.requestId,
    author_unit: thread.createdUserUnitName ?? "",
    author_unit_id: thread.createdUserUnitId ?? 0,
    is_ours: isOurThread(thread) ? 1 : 0,
    res_date_ms: typeof thread.resDate === "number" ? thread.resDate : null,
    res_date_val: thread.resDateVal ?? "",
    body_html: html,
    body_text: htmlToText(html),
    fetched_at: now,
  };
}


/**
 * 세션을 확보한다.
 *
 * 저장된 세션이 유효하면 그대로 쓰고, 만료됐으면 계정이 있을 때 한 번만 재로그인한다.
 * 재로그인도 실패하면 예외를 그대로 올려 'session_expired' 로 기록되게 한다.
 * (조용히 빈 결과를 돌려주면 '새 답변 없음'과 구분되지 않는다)
 */
async function acquireSession(): Promise<Awaited<ReturnType<typeof openSavedSession>>> {
  try {
    const existing = await openSavedSession();
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
  const context = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await context.newPage();
  await performCredentialLogin(page);
  await page.close().catch(() => undefined);
  await saveSession(context);

  const session = {
    browser,
    context,
    close: async () => {
      await browser.close().catch(() => undefined);
    },
  };
  await ensureSessionValid(session.context);
  return session;
}

/** 스레드에 딸린 첨부 목록. 파일 자체는 Broadcom 쪽에 있어 링크만 보관한다. */
function toAttachmentRows(thread: RequestThreadVo, now: string): AttachmentRow[] {
  return (thread.docList ?? [])
    .filter((doc) => doc.active !== false && Number(doc.requestDocumentId) > 0)
    .map((doc) => ({
      document_id: doc.requestDocumentId,
      request_id: doc.requestId || thread.requestId,
      thread_id: doc.requestThreadId || thread.requestThreadId,
      doc_name: doc.docName ?? "",
      doc_path: doc.docFullPath ?? "",
      content_type: doc.contentType ?? "",
      file_size: Number(doc.fileSize) || 0,
      uploaded_by: doc.userFullName ?? "",
      uploaded_at: doc.uploadedOnVal ?? "",
      uploaded_ms: typeof doc.uploadedOn === "number" ? doc.uploadedOn : null,
      fetched_at: now,
    }));
}

async function main(): Promise<void> {
  const release = acquireLock();
  if (release === null) {
    console.log("다른 수집기가 이미 실행 중입니다. 이번 회차는 건너뜁니다.");
    return;
  }

  const db = openDb();
  const runId = startRun(db);
  let session: Awaited<ReturnType<typeof openSavedSession>> | null = null;

  try {
    session = await acquireSession();
    // 접속하는 순간 서버가 세션 쿠키를 회전시킨다.
    // 갱신분을 저장하지 않으면 파일에 남은 옛 쿠키가 무효화되어 다음 실행이 실패한다.
    // 이는 데이터 쓰기가 아니므로 dry-run 에서도 반드시 저장한다.
    await persistSession(session.context);

    const cases = await gatherCases(session.context);
    const known = getExistingCaseIndex(db);
    const changes = selectChangedCases(cases, known);
    const now = isoNow();

    const replies: NewReply[] = [];
    const details = new Map<number, CaseDetail>();
    let newThreadCount = 0;

    for (const change of changes) {
      const threads = await fetchThreads(session.context, change.item.requestId);
      const knownIds = getKnownThreadIds(db, change.item.requestId);
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
        });
      }

      // 케이스 본문은 변경된 건에 대해서만 가져온다.
      details.set(change.item.requestId, await fetchCaseDescription(session.context, change.item.requestId));

      if (!DRY_RUN) {
        for (const thread of threads) {
          upsertThread(db, toThreadRow(thread, now));
          for (const doc of toAttachmentRows(thread, now)) upsertAttachment(db, doc);
        }
      }
      await sleep(REQUEST_DELAY_MS);
    }

    if (!DRY_RUN) {
      for (const item of cases) {
        upsertCase(db, toCaseRow(item, now, details.get(item.requestId)));
      }
    }
    // 수집 도중에도 쿠키가 갱신되므로 마지막 상태를 한 번 더 저장한다.
    await persistSession(session.context);

    finishRun(db, runId, {
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

    finishRun(db, runId, {
      status: expired ? "session_expired" : "failed",
      sessionState: expired ? "expired" : "unknown",
      error: message,
    });

    console.error(expired ? "\n[세션 문제] " + message : "\n[수집 실패] " + message);
    console.error("주의: 이번 회차는 조회하지 못했습니다. '새 답변 없음'이 아닙니다.");
    process.exitCode = 1;
  } finally {
    await session?.close();
    db.close();
    release();
  }
}

/** 새 답변을 메신저로 알린다. 웹훅이 없으면 조용히 넘어간다. */
async function announceReplies(replies: readonly NewReply[]): Promise<void> {
  if (replies.length === 0 || !hasWebhook()) return;
  const result = await send(formatReplies(replies));
  if (!result.ok) console.error(`알림 전송 실패: ${result.detail}`);
}

/**
 * 수집 실패를 알린다.
 *
 * 15분마다 도는데 매번 보내면 도배가 된다. 직전 회차도 같은 상태였다면
 * 이미 알린 것이므로 건너뛴다 — 상태가 바뀌는 순간에만 알린다.
 */
async function announceFailure(
  db: ReturnType<typeof openDb>,
  runId: number,
  kind: "session" | "failed",
  message: string,
): Promise<void> {
  if (!hasWebhook()) return;
  const status = kind === "session" ? "session_expired" : "failed";
  const rows = db
    .prepare("SELECT status FROM runs WHERE run_id < ? ORDER BY run_id DESC LIMIT 1")
    .all(runId) as Array<{ status: string }>;
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
