/**
 * 포털 응답 → DB 행 변환.
 *
 * 수집기와 쓰기 API(답변 등록 직후의 타겟 갱신)가 같은 매핑을 써야 한다.
 * 한쪽만 고치면 같은 케이스가 경로에 따라 다르게 저장된다.
 */
import type { CaseDetail } from "../collector/api.ts";
import { DEFAULT_TEAM_ID } from "./config.ts";
import { toEpochMs } from "./dates.ts";
import { htmlToText, isOurThread } from "./diff.ts";
import type { AttachmentRow, RequestThreadVo, SearchResultItem } from "./types.ts";

/**
 * teamId 를 생략하면 기본 팀으로 귀속된다 — 기존 수집기 호출부는 그대로
 * 기본 팀 케이스를 만든다. MCP create_sr 도구처럼 실제 팀이 있을 때만 넘긴다.
 */
export function toCaseRow(
  item: SearchResultItem,
  now: string,
  detail?: CaseDetail,
  teamId: string = DEFAULT_TEAM_ID,
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
    team_id: teamId,
  };
}

export function toThreadRow(thread: RequestThreadVo, now: string) {
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

/** 스레드에 딸린 첨부 목록. 파일 자체는 Broadcom 쪽에 있어 링크만 보관한다. */
export function toAttachmentRows(thread: RequestThreadVo, now: string): AttachmentRow[] {
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
