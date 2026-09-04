/**
 * Wolken 조회 API 클라이언트.
 *
 * ★ 읽기 전용이다. 케이스 생성/수정/삭제 함수는 의도적으로 존재하지 않는다.
 *   (PRD: 사람 승인 없는 전송 금지. 마일스톤 4 이전에는 쓰기 경로 자체를 두지 않는다)
 *
 * 엔드포인트와 페이로드는 captured/ 의 실제 트래픽에서 가져왔다. 추측한 것이 없다.
 */
import { readFileSync } from "node:fs";
import type { APIRequestContext, BrowserContext } from "playwright";
import { API_HEADERS, API_ORIGIN, MAX_PAGES, PAGE_SIZE, REQUEST_DELAY_MS } from "../lib/config.ts";
import { SessionExpiredError } from "./session.ts";
import type { RequestThreadVo, SearchResultItem, UnifiedHistoryEntry } from "../lib/types.ts";

const OPEN_PAYLOAD_PATH = new URL("./payloads/search.json", import.meta.url);
/**
 * 종료 케이스 조회 payload.
 * 실측: filterCondition 을 비우는 게 아니라 closedOn(attributeId 16) 날짜 조건으로
 * 바꿔야 한다. 포털이 쓰는 값이 LAST_3_MONTH 라 최근 3개월 범위가 그대로 맞는다.
 */
const CLOSED_PAYLOAD_PATH = new URL("./payloads/closed.json", import.meta.url);

interface SearchPayloadFile {
  data: string;
  pagination: string;
}

interface ApiEnvelope<T> {
  status: string;
  message: string;
  data: T;
}

export type CaseScope = "open" | "closed";

function loadSearchDetails(scope: CaseScope): Record<string, unknown> {
  const path = scope === "open" ? OPEN_PAYLOAD_PATH : CLOSED_PAYLOAD_PATH;
  const file = JSON.parse(readFileSync(path, "utf8")) as SearchPayloadFile;
  return JSON.parse(file.data) as Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postMultipart<T>(
  request: APIRequestContext,
  path: string,
  parts: Record<string, string>,
): Promise<ApiEnvelope<T>> {
  const response = await request.post(`${API_ORIGIN}${path}`, {
    multipart: parts,
    headers: API_HEADERS,
  });
  if (response.status() === 401) {
    throw new SessionExpiredError(`세션 만료로 조회 실패: ${path}`);
  }
  if (!response.ok()) {
    throw new Error(`조회 실패 ${path}: HTTP ${response.status()}`);
  }
  return (await response.json()) as ApiEnvelope<T>;
}

async function getJson<T>(request: APIRequestContext, url: string): Promise<ApiEnvelope<T>> {
  const response = await request.get(url, { headers: API_HEADERS });
  if (response.status() === 401) {
    throw new SessionExpiredError(`세션 만료로 조회 실패: ${url}`);
  }
  if (!response.ok()) {
    throw new Error(`조회 실패 ${url}: HTTP ${response.status()}`);
  }
  return (await response.json()) as ApiEnvelope<T>;
}

/**
 * 케이스 목록을 페이지 단위로 순회한다.
 * shouldStop 이 true를 반환하면 더 훑지 않는다(백필 경계 제어).
 */
export async function fetchCaseList(
  context: BrowserContext,
  options: {
    scope: CaseScope;
    shouldStop?: (page: readonly SearchResultItem[]) => boolean;
  },
): Promise<SearchResultItem[]> {
  const data = loadSearchDetails(options.scope);
  const collected: SearchResultItem[] = [];

  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
    const pagination = {
      offset: pageIndex * PAGE_SIZE,
      limit: PAGE_SIZE,
      sortBy: "rm.request_id",
      orderBy: "desc",
    };

    const envelope = await postMultipart<{ SearchResultList?: SearchResultItem[] }>(
      context.request,
      "/dynamic_views/search/list/v3",
      { data: JSON.stringify(data), pagination: JSON.stringify(pagination) },
    );

    const page = envelope.data?.SearchResultList ?? [];
    collected.push(...page);

    if (page.length < PAGE_SIZE) break;
    if (options.shouldStop?.(page)) break;
    await sleep(REQUEST_DELAY_MS);
  }

  return collected;
}

/** 케이스 하나의 답변 스레드 전체. */
export async function fetchThreads(
  context: BrowserContext,
  requestId: number,
  limit = 100,
): Promise<RequestThreadVo[]> {
  const url =
    `${API_ORIGIN}/request/get_unified_history` +
    `?requestId=${requestId}&offset=0&limit=${limit}&orderBy=desc&sortBy=res_date`;

  const envelope = await getJson<{ RequestDetails?: UnifiedHistoryEntry[] }>(context.request, url);
  const entries = envelope.data?.RequestDetails ?? [];

  return entries
    .map((entry) => entry.requestThreadVo)
    .filter((vo): vo is RequestThreadVo => Boolean(vo) && Number(vo?.requestThreadId) > 0);
}

/**
 * 케이스 본문(우리가 최초 등록할 때 쓴 내용).
 *
 * 스레드가 아니라 descDetailsVO.descLarge 에 따로 들어 있어서 별도로 가져와야 한다.
 * 실패해도 수집 전체를 세우지 않는다 — 빈 문자열을 돌려주면 기존 값이 유지된다.
 */
export async function fetchCaseDescription(
  context: BrowserContext,
  requestId: number,
): Promise<CaseDetail> {
  // 실측 파라미터는 sections= 이고, 본문만 필요하니 DESC_DETAIL 만 요청한다.
  // (전체 섹션을 부르면 응답이 60KB 를 넘는다)
  const url =
    `${API_ORIGIN}/request/specific_request_details` +
    `?requestId=${requestId}&sections=REQUEST_MASTER,DESC_DETAIL,COMPONENT`;
  try {
    const envelope = await getJson<{
      RequestDetails?: {
        descDetailsVO?: { descLarge?: string };
        requestMasterVO?: {
          version?: number;
          subCategoryId?: number;
          subCategoryName?: string;
        };
        componentMappingList?: Array<{ compId?: number; compName?: string }>;
      };
    }>(context.request, url);

    const details = envelope.data?.RequestDetails;
    const master = details?.requestMasterVO;
    const component = details?.componentMappingList?.[0];

    return {
      description: details?.descDetailsVO?.descLarge ?? "",
      version: typeof master?.version === "number" ? master.version : null,
      productId: typeof master?.subCategoryId === "number" ? master.subCategoryId : null,
      productName: master?.subCategoryName ?? "",
      componentId: typeof component?.compId === "number" ? component.compId : null,
      componentName: component?.compName ?? "",
    };
  } catch (error) {
    if (error instanceof SessionExpiredError) throw error;
    return EMPTY_DETAIL;
  }
}

export interface CaseDetail {
  description: string;
  version: number | null;
  productId: number | null;
  productName: string;
  componentId: number | null;
  componentName: string;
}

const EMPTY_DETAIL: CaseDetail = {
  description: "", version: null,
  productId: null, productName: "", componentId: null, componentName: "",
};
