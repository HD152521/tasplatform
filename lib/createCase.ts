/**
 * 새 SR 을 등록한다.
 *
 * ★ 답변 등록과 함께, 이 도구가 Broadcom 쪽에 쓰기를 하는 두 곳 중 하나다.
 *   화면에서 사람이 내용을 확인하고 전송을 누를 때만 호출된다.
 *
 * 실측 요청 (캡처 107_create_request):
 *   POST /request/create_request   multipart/form-data, 파트 = data
 *   제목과 본문은 Base64 로 인코딩해서 넣는다.
 *
 * ⚠ 제약: payload 에는 categoryId·itemId·releaseId·entlId·compId 같은 ID 가 들어가는데,
 *   그 선택지 목록을 아직 확보하지 못했다. 그래서 실제로 등록했던 SR 하나를 템플릿으로
 *   두고 제목·본문·우선순위만 바꿔 보낸다. 제품이나 릴리스가 다른 SR 은 이 경로로 보낼 수 없다.
 *   (포털 작성 화면의 드롭다운을 한 번 캡처하면 풀린다)
 */
import "server-only";
import type { BrowserContext } from "playwright";
import { API_HEADERS, API_ORIGIN } from "./config.ts";
import { textToHtml } from "./html.ts";

/**
 * 등록 템플릿.
 *
 * 원본은 `collector/payloads/create.json` (캡처 107_create_request) 이지만,
 * 여기서는 파일을 읽지 않고 문자열 상수로 둔다.
 * Next.js 번들 환경에서는 readFileSync(new URL(..., import.meta.url)) 이
 * "The \"path\" argument must be of type string ... Received an instance of URL"
 * 로 죽는다 — 번들러가 URL 을 자체 shim 으로 바꿔 fs 가 거부한다(실측 확인).
 * lib/schema.ts 가 같은 이유로 .sql 파일 대신 상수를 쓴다.
 *
 * 캡처를 다시 떠서 값이 바뀌면 이 상수도 같이 고칠 것.
 */
const TEMPLATE = {
  '"null"': null,
  requestMasterVO: {
    subCategoryId: 4322,
    priorityId: 3,
    requestDesc: "",
    categoryId: 3561,
    itemId: 69076,
    sourceId: 1,
    unitId: 25326,
    requestTypeId: 63,
  },
  assetId: null,
  otherInfoVO: {
    unitLocationId: 2565181,
    releaseId: 798,
    onBehalfOfSite: null,
    attribute1: null,
    attribute2: null,
    attribute3: null,
  },
  requestEntitlementsVO: { groupSiteId: null, entlId: 10486720 },
  componentMappingList: [{ compId: 9698, compReleaseId: null }],
  descDetailsVO: { descLarge: "" },
  emailCCVO: {},
  emailCCExternalVO: {},
  enableDefaultContext: false,
  itemFlexMapValueList: [],
  subcatFlexMapValueList: [],
  requestFlexMapValueList: [
    {
      attributeId: 697,
      attributeTypeId: 2,
      attributeName: "Issue Type",
      requestFlexMapId: 572,
      lovName: "Technical",
      lovId: 4323,
      isDeleted: false,
    },
  ],
  itemSectionMapValueList: [],
  requestSectionMapValueList: [],
  configType: "PRODUCT_DRIVEN",
  itemPrototypeMapValueList: [],
  requestPrototypeMapValueList: [],
  multiLevelFlexConfigurationValueList: [],
  unitFlexMapValueList: [],
} as const;

export const PRIORITIES: ReadonlyArray<{ id: number; label: string }> = [
  { id: 1, label: "Critical - P1" },
  { id: 2, label: "High - P2" },
  { id: 3, label: "Medium - P3" },
  { id: 4, label: "Low - P4" },
];

export interface TemplateInfo {
  subCategoryId: number;
  itemId: number;
  releaseId: number;
  compId: number;
  issueType: string;
}

export type CreateResult =
  | { ok: true; requestId: number; requestIdFormatted: string; message: string }
  | { ok: false; code: "session" | "failed"; message: string };

/** 호출마다 새 사본을 준다 — 아래에서 제목·본문을 덮어쓰기 때문에 공유하면 안 된다. */
function loadTemplate(): Record<string, any> {
  return JSON.parse(JSON.stringify(TEMPLATE)) as Record<string, any>;
}

/** 화면에서 "이 값으로 나갑니다"를 보여주기 위한 요약. */
export function templateInfo(): TemplateInfo {
  const t = loadTemplate();
  const flex = (t["requestFlexMapValueList"] as Array<{ lovName?: string }>)[0];
  return {
    subCategoryId: t["requestMasterVO"].subCategoryId,
    itemId: t["requestMasterVO"].itemId,
    releaseId: t["otherInfoVO"].releaseId,
    compId: (t["componentMappingList"] as Array<{ compId: number }>)[0]?.compId ?? 0,
    issueType: flex?.lovName ?? "",
  };
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

export async function createCase(
  context: BrowserContext,
  input: {
    subject: string; content: string; priorityId: number;
    productId?: number; componentId?: number;
  },
): Promise<CreateResult> {
  const payload = loadTemplate();
  payload["requestMasterVO"].requestDesc = b64(input.subject);
  payload["requestMasterVO"].priorityId = input.priorityId;
  payload["descDetailsVO"].descLarge = b64(textToHtml(input.content));

  // 고른 Product / Component 로 바꿔 넣는다.
  // 나머지 ID(categoryId·itemId·entlId·releaseId)는 템플릿 값이 남으므로,
  // 템플릿과 다른 제품을 고르면 서버가 거절할 수 있다. 그 오류는 화면에 그대로 보여준다.
  if (typeof input.productId === "number") {
    payload["requestMasterVO"].subCategoryId = input.productId;
  }
  if (typeof input.componentId === "number") {
    payload["componentMappingList"] = [{ compId: input.componentId, compReleaseId: null }];
  }

  const response = await context.request.post(`${API_ORIGIN}/request/create_request`, {
    multipart: { data: JSON.stringify(payload) },
    headers: API_HEADERS,
  });

  if (response.status() === 401) {
    return { ok: false, code: "session", message: "세션이 만료되었습니다. 다시 로그인하세요." };
  }

  let parsed: {
    status?: string;
    message?: string;
    data?: { requestId?: number; requestIdFormatted?: string };
  } = {};
  try {
    parsed = (await response.json()) as typeof parsed;
  } catch {
    parsed = {};
  }

  const id = parsed.data?.requestId;
  if (response.ok() && (parsed.status ?? "").toLowerCase() === "success" && typeof id === "number") {
    return {
      ok: true,
      requestId: id,
      requestIdFormatted: parsed.data?.requestIdFormatted ?? String(id),
      message: parsed.message ?? "케이스를 등록했습니다.",
    };
  }

  return {
    ok: false,
    code: "failed",
    message: parsed.message ?? `등록에 실패했습니다 (HTTP ${response.status()}).`,
  };
}
