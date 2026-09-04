/** 포털 응답 타입. captured/ 의 실제 응답에서 도출했다. */

/** dynamic_views/search/list/v3 의 SearchResultList 원소 */
export interface SearchResultItem {
  requestId: number;
  requestIdFormatted: string;
  requestDesc: string;
  statusAliasName: string;
  priorityName: string;
  subCategoryName: string;
  partyName: string;
  partySiteNumber: string;
  createdOn: string;
  lastUpdated: string;
}

/** request/get_unified_history 의 requestThreadVo */
export interface RequestThreadVo {
  requestThreadId: number;
  requestId: number;
  createdUserUnitName: string;
  createdUserUnitId: number;
  creatorFlag: boolean;
  requestStatus: string;
  resDate: number;
  resDateVal: string;
  resDesc: string;
  attachmentFlag: boolean;
  attachmentName: string;
  attachmentUrl: string;
  docList?: DocListItem[];
}

/** requestThreadVo.docList 원소. 실측 응답에서 도출했다. */
export interface DocListItem {
  requestDocumentId: number;
  requestId: number;
  requestThreadId: number;
  docName: string;
  docFullPath: string;
  contentType: string;
  fileSize: number;
  userFullName: string;
  uploadedOn: number;
  uploadedOnVal: string;
  showAttachment: boolean;
  active: boolean;
}

export interface AttachmentRow {
  document_id: number;
  request_id: number;
  thread_id: number | null;
  doc_name: string;
  doc_path: string;
  content_type: string;
  file_size: number;
  uploaded_by: string;
  uploaded_at: string;
  uploaded_ms: number | null;
  fetched_at: string;
}

export interface UnifiedHistoryEntry {
  requestThreadVo?: RequestThreadVo;
}

/** DB 행 */
export interface CaseRow {
  request_id: number;
  request_id_formatted: string;
  subject: string;
  status: string;
  priority: string;
  category: string;
  party_name: string;
  party_site_number: string;
  created_on: string;
  created_on_ms: number | null;
  last_updated: string;
  last_updated_ms: number | null;
  first_seen_at: string;
  last_fetched_at: string;
  raw_json: string;
  description_html: string;
  description_text: string;
  case_version: number | null;
  product_id: number | null;
  product_name: string;
  component_id: number | null;
  component_name: string;
}

export interface ThreadRow {
  thread_id: number;
  request_id: number;
  author_unit: string;
  author_unit_id: number;
  is_ours: number;
  res_date_ms: number | null;
  res_date_val: string;
  body_html: string;
  body_text: string;
  fetched_at: string;
}

export type RunStatus = "success" | "session_expired" | "failed";

export interface RunRow {
  run_id: number;
  started_at: string;
  finished_at: string | null;
  status: RunStatus;
  cases_seen: number;
  cases_changed: number;
  new_threads: number;
  session_state: string;
  error: string | null;
}
