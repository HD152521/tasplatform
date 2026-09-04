/**
 * 케이스에 답글을 등록한다.
 *
 * ★ 이 파일이 이 도구에서 유일하게 Broadcom 쪽에 쓰기를 하는 곳이다.
 *   화면에서 사람이 내용을 확인하고 전송을 누를 때만 호출된다.
 *
 * 실측한 요청 형태 (캡처 119_end_user_add_response):
 *   POST /request/end_user_add_response   multipart/form-data, 파트 = data
 *   {
 *     "requestIdFormatted": "37074111",
 *     "requestId": "37074111",
 *     "threadVO": { "responseTypeDesc": "REQUEST_UPDATE", "resDesc": "<base64 HTML>" },
 *     "requestMasterVO": { "version": 4 },
 *     "fileAttach": []
 *   }
 *
 * version 은 낙관적 잠금이다. 보내기 직전에 케이스에서 읽어 와야 하고,
 * 그 사이 상대가 답글을 달면 서버가 거절한다 — 못 본 답변 위에 덮어쓰는 것을 막아준다.
 */
import "server-only";
import type { BrowserContext } from "playwright";
import { API_HEADERS, API_ORIGIN } from "./config.ts";
import { textToHtml } from "./html.ts";

export type ReplyResult =
  | { ok: true; message: string }
  | { ok: false; code: "session" | "version" | "failed"; message: string };

/** 케이스의 현재 version. 답글 전송에 반드시 필요하다. */
async function readVersion(
  context: BrowserContext,
  requestId: number,
): Promise<number | null> {
  const url =
    `${API_ORIGIN}/request/specific_request_details` +
    `?requestId=${requestId}&sections=REQUEST_MASTER`;
  const response = await context.request.get(url, { headers: API_HEADERS });
  if (!response.ok()) return null;

  const body = (await response.json()) as {
    data?: { RequestDetails?: { requestMasterVO?: { version?: number } } };
  };
  const version = body.data?.RequestDetails?.requestMasterVO?.version;
  return typeof version === "number" ? version : null;
}

export async function postReply(
  context: BrowserContext,
  requestId: number,
  text: string,
): Promise<ReplyResult> {
  const version = await readVersion(context, requestId);
  if (version === null) {
    return {
      ok: false,
      code: "version",
      message: "케이스 상태를 읽지 못했습니다. 잠시 후 다시 시도하세요.",
    };
  }

  const payload = {
    requestIdFormatted: String(requestId),
    requestId: String(requestId),
    threadVO: {
      responseTypeDesc: "REQUEST_UPDATE",
      resDesc: Buffer.from(textToHtml(text), "utf8").toString("base64"),
    },
    requestMasterVO: { version },
    fileAttach: [],
  };

  const response = await context.request.post(
    `${API_ORIGIN}/request/end_user_add_response`,
    { multipart: { data: JSON.stringify(payload) }, headers: API_HEADERS },
  );

  if (response.status() === 401) {
    return { ok: false, code: "session", message: "세션이 만료되었습니다. 다시 로그인하세요." };
  }

  const raw = await response.text();
  let parsed: { status?: string; message?: string } = {};
  try {
    parsed = JSON.parse(raw) as { status?: string; message?: string };
  } catch {
    parsed = {};
  }

  if (response.ok() && (parsed.status ?? "").toLowerCase() === "success") {
    return { ok: true, message: parsed.message ?? "답변을 등록했습니다." };
  }

  // version 이 어긋난 경우가 여기로 온다 — 그 사이 상대가 답글을 달았다는 뜻이다.
  return {
    ok: false,
    code: "failed",
    message: parsed.message ?? `전송에 실패했습니다 (HTTP ${response.status()}).`,
  };
}
