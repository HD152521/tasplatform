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
import type { ApiClient } from "../collector/httpClient.ts";
import { API_HEADERS, API_ORIGIN } from "./config.ts";
import { textToHtml } from "./html.ts";

export type ReplyResult =
  | { ok: true; message: string }
  | { ok: false; code: "session" | "version" | "failed"; message: string };

/**
 * 케이스의 현재 version. 답글 전송에 반드시 필요하다.
 *
 * **왜 실패 이유를 나눠 돌려주는가.** 예전에는 어떤 실패든 null 이었다. 그래서 세션이
 * 만료돼 401 이 와도 화면에는 "케이스 상태를 읽지 못했습니다. 잠시 후 다시 시도하세요"
 * 가 떴고, 담당자는 기다리기만 했다 — 실제로 할 일은 다시 로그인하는 것이었다.
 * 사람이 다음에 할 행동이 갈리므로 여기서 구분해 올린다.
 */
type VersionRead =
  | { ok: true; version: number }
  | { ok: false; reason: "session" | "failed"; detail: string };

async function readVersion(
  client: ApiClient,
  requestId: number,
): Promise<VersionRead> {
  const url =
    `${API_ORIGIN}/request/specific_request_details` +
    `?requestId=${requestId}&sections=REQUEST_MASTER`;
  const response = await client.get(url, { headers: API_HEADERS });
  if (response.status() === 401) return { ok: false, reason: "session", detail: "HTTP 401" };
  if (!response.ok()) return { ok: false, reason: "failed", detail: `HTTP ${response.status()}` };

  // 세션이 죽으면 401 이 아니라 로그인 화면(HTML)이 200 으로 오는 경우도 있다.
  // 그때 json() 이 던지는 것을 여기서 받아 "읽지 못했다"로 돌린다.
  let body: { data?: { RequestDetails?: { requestMasterVO?: { version?: number } } } };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return { ok: false, reason: "session", detail: "응답이 JSON 이 아님(로그인 화면일 수 있음)" };
  }
  const version = body.data?.RequestDetails?.requestMasterVO?.version;
  if (typeof version !== "number") {
    return { ok: false, reason: "failed", detail: "응답에 version 이 없음" };
  }
  return { ok: true, version };
}

export async function postReply(
  client: ApiClient,
  requestId: number,
  text: string,
): Promise<ReplyResult> {
  const read = await readVersion(client, requestId);
  if (!read.ok) {
    if (read.reason === "session") {
      return {
        ok: false,
        code: "session",
        message: "세션이 만료되었습니다. 다시 로그인하세요.",
      };
    }
    return {
      ok: false,
      code: "version",
      message: `케이스 상태를 읽지 못했습니다 (${read.detail}). 잠시 후 다시 시도하세요.`,
    };
  }
  const version = read.version;

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

  const response = await client.post(
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
