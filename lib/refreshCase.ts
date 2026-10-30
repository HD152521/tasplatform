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
import { untilReflected } from "./reflectWait.ts";

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

/* ------------------------------------------------------------------ *
 * 반영됐는지 **확인한다**
 *
 * 위 두 함수는 "한 번 받아 넣기" 까지만 한다. 그래서 받아 넣었는데도 방금 쓴 글이
 * 없는 경우를 구분하지 못했다 — 포털이 글을 받아 두고 목록·스레드 조회에 바로
 * 싣지 않는 순간이 있다. 화면은 성공이라 말하고 대화는 그대로니, 담당자는 "다음
 * 수집 때 반영됩니다" 를 읽고 **15분을 기다렸다.**
 *
 * 그래서 넣은 뒤 **세어 본다.** 늘지 않았으면 잠깐 두고 다시 묻는다(lib/reflectWait.ts).
 * 몇 번 물어도 안 보이면 거짓말하지 않고 그대로 돌려준다 — 화면이 "아직 안 보인다" 고
 * 말할 근거가 된다. 사람이 앞에서 기다리는 구간이라 오래 끌지 않는다.
 * ------------------------------------------------------------------ */

/** 그 케이스에 쌓인 글 수. 새 글이 들어왔는지는 **수가 늘었는지**로 안다. */
async function threadCount(requestId: number): Promise<number> {
  const db = await openDb();
  try {
    const rows = (await db.all(
      "SELECT COUNT(*) AS n FROM threads WHERE request_id = ?",
      [requestId],
    )) as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0);
  } finally {
    await db.close();
  }
}

/** 그 케이스 행이 생겼는가. */
async function caseExists(requestId: number): Promise<boolean> {
  const db = await openDb();
  try {
    const rows = await db.all("SELECT 1 FROM cases WHERE request_id = ?", [requestId]);
    return rows.length > 0;
  } finally {
    await db.close();
  }
}

/**
 * 방금 보낸 답변이 화면에 보이게 될 때까지 끌어온다.
 *
 * 돌려주는 값은 **대화에 실제로 늘었는가**다. 화면이 "바로 보입니다" 와 "아직 포털에
 * 안 보입니다" 중 무엇을 말할지 정하는 데 쓴다. 틀린 안내 한 줄이 15분을 버리게 한다.
 */
export async function reflectReply(client: ApiClient, requestId: number): Promise<boolean> {
  const before = await threadCount(requestId);
  return untilReflected(
    () => refreshCaseThreads(client, requestId),
    async () => (await threadCount(requestId)) > before,
  );
}

/** 방금 만든 케이스가 목록에 잡힐 때까지 끌어온다. 돌려주는 값은 행이 생겼는가다. */
export async function reflectNewCase(
  client: ApiClient,
  teamId: string,
  requestId: number,
): Promise<boolean> {
  return untilReflected(
    () => refreshOpenCases(client, teamId, requestId),
    () => caseExists(requestId),
  );
}
