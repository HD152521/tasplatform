/**
 * 한 케이스만 즉시 갱신한다.
 *
 * 답변을 보내거나 케이스를 만든 직후에 쓴다. 정기 수집(15분 간격)을 기다리면
 * 자기가 방금 쓴 글이 화면에 안 보인다. 그렇다고 전체 수집을 부르면 6초가 들고,
 * 마침 스케줄 수집이 돌고 있으면 락에 막혀 오히려 반영이 안 된다.
 * 바뀐 건 그 케이스 하나뿐이니 그것만 가져오면 요청 1건으로 끝난다.
 *
 * 실패해도 예외를 올리지 않는다 — 전송은 이미 성공했고, 화면 반영이 조금 늦을 뿐
 * 다음 정기 수집이 결국 맞춰 놓는다. 여기서 터뜨리면 사용자는 "전송 실패"로 오해한다.
 */
import "server-only";
import type { ApiClient } from "../collector/httpClient.ts";
import { fetchCaseDescription, fetchCaseList, fetchThreads, type CaseDetail } from "../collector/api.ts";
import { DEFAULT_TEAM_ID } from "./config.ts";
import { isoNow } from "./dates.ts";
import { inTransaction, openDb, upsertAttachment, upsertCase, upsertThread } from "./db.ts";
import { toAttachmentRows, toCaseRow, toThreadRow } from "./rowMappers.ts";

/** 답변 등록 후: 그 케이스의 스레드와 첨부만 새로 넣는다. */
export async function refreshCaseThreads(client: ApiClient, requestId: number): Promise<boolean> {
  try {
    const threads = await fetchThreads(client, requestId);
    if (threads.length === 0) return false;

    const now = isoNow();
    const db = await openDb();
    try {
      await inTransaction(db, async (tx) => {
        for (const thread of threads) {
          await upsertThread(tx, toThreadRow(thread, now));
          for (const doc of toAttachmentRows(thread, now)) await upsertAttachment(tx, doc);
        }
      });
    } finally {
      await db.close();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 케이스 생성 후: 진행중 목록을 한 번 받아 새 케이스를 넣는다.
 *
 * 스레드와 달리 새 케이스는 DB 에 행 자체가 없고, 행을 만들려면 목록 항목이 필요하다.
 * 진행중 목록은 보통 한 페이지라 요청 1건으로 끝난다.
 *
 * teamId 를 생략하면 기존 호출부(기본 팀 화면)와 동일하게 동작한다.
 * MCP create_sr 도구는 실제 teamId 를 넘겨 새로 생긴 행이 그 팀 소유로 찍히게 한다
 * (이월 항목: team_id 배선).
 *
 * detailFor 에 방금 만든 requestId 를 주면 **그 케이스의 본문과 스레드까지** 함께
 * 가져온다. 목록 항목에는 본문이 없어서, 이게 없으면 방금 올린 SR 을 열었을 때
 * 내용이 비어 보인다 — 정기 수집(15분)이 돌기까지 자기가 쓴 글을 못 본다.
 * 본문은 지정한 한 건에 대해서만 받으므로 요청은 1건만 늘어난다.
 */
export async function refreshOpenCases(
  client: ApiClient,
  teamId: string = DEFAULT_TEAM_ID,
  detailFor?: number,
): Promise<boolean> {
  try {
    const items = await fetchCaseList(client, { scope: "open" });
    if (items.length === 0) return false;

    // 목록에 그 건이 실제로 있을 때만 본문을 부른다. 본문 실패가 목록 반영을 막지는
    // 않는다 — 제목·상태라도 보이는 편이 아무것도 안 보이는 것보다 낫다.
    let detail: CaseDetail | undefined;
    if (detailFor !== undefined && items.some((item) => item.requestId === detailFor)) {
      try {
        detail = await fetchCaseDescription(client, detailFor);
      } catch {
        detail = undefined;
      }
    }

    const now = isoNow();
    const db = await openDb();
    try {
      await inTransaction(db, async (tx) => {
        for (const item of items) {
          const own = item.requestId === detailFor ? detail : undefined;
          await upsertCase(tx, toCaseRow(item, now, own, teamId));
        }
      });
    } finally {
      await db.close();
    }

    // 첫 글이 본문이 아니라 스레드로 잡히는 경우도 있어 함께 받아 둔다.
    if (detailFor !== undefined) await refreshCaseThreads(client, detailFor);
    return true;
  } catch {
    return false;
  }
}
