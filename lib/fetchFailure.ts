/**
 * 전송이 깨진 "이유" 를 잃지 않게 한다.
 *
 * Node 의 fetch(undici)는 연결이 깨지면 **`TypeError: fetch failed` 하나만** 던진다.
 * 진짜 사유는 `error.cause` 에 들어 있고, 그 cause 에 또 cause 가 달린다. 그래서
 * `error.message` 만 꺼내 쓰면 화면·감사 로그·journalctl 에 전부 "fetch failed" 만
 * 남는다 — **실제로 그랬다.** 첨부 한 건이 화면에 `KakaoTalk_….jpg: fetch failed` 로
 * 끝났는데(2026-11-17), DNS 인지 시간초과인지 중간에 끊긴 것인지 끝까지 알 수 없었다.
 * 작업 행에 적힌 사유가 그 네 글자였기 때문이다(attachment_jobs.error).
 *
 * 처방이 코드마다 다르다는 것이 요점이다.
 *
 *   ENOTFOUND / EAI_AGAIN                 이름을 못 찾음 — DNS·망 설정
 *   ECONNREFUSED                          상대가 거절 — 포트·방화벽
 *   ETIMEDOUT / UND_ERR_CONNECT_TIMEOUT   손도 못 잡음 — 경로가 막혔다
 *   ECONNRESET / UND_ERR_SOCKET / EPIPE   잡았다가 끊김 — 중간 장비·본문 크기
 *   CERT_* / ERR_TLS_*                    인증서
 *
 * 이걸 "fetch failed" 하나로 뭉치면 같은 증상이 열 번 나도 열 번 다 처음부터 조사한다.
 *
 * ## 왜 의존성이 없는가
 *
 * 서버(수집기·라우트)와 클라이언트(버튼) 양쪽에서 같은 문구를 보여야 한다. node: 모듈을
 * 하나라도 물면 클라이언트 번들이 깨지므로 순수하게 둔다(lib/attachmentUpload.ts 와 같은 이유).
 */

/** 사슬을 따라갈 상한. 순환이면 더 가지 않는다. */
const MAX_DEPTH = 6;

/** 사람에게 보여줄 길이 상한. 이 문구는 DB 칸과 화면에 그대로 들어간다. */
const MAX_MESSAGE = 240;

export interface FetchFailure {
  /** 사람에게 보여줄 한 줄. 사유를 알 수 없으면 그렇다고 말한다. */
  readonly message: string;
  /** undici·libuv 가 준 코드(ETIMEDOUT 등). 없으면 빈 문자열. */
  readonly code: string;
  /**
   * 전송 단계에서 깨졌는가.
   *
   * true 면 **같은 요청을 다시 보내 볼 수 있다** — 서버가 판단해서 거절한 것이 아니라
   * 말이 닿지 않은 것이다. 4xx 는 다시 보내도 같은 답이므로 여기에 들어오지 않는다.
   */
  readonly transport: boolean;
}

/** 사슬의 한 칸. Error 가 아닌 것도 같은 모양으로 읽는다. */
interface Link {
  readonly name: string;
  readonly message: string;
  readonly code: string;
}

/**
 * 코드별 안내 문구.
 *
 * 순서가 뜻을 가진다 — 위에서부터 처음 맞는 것을 쓴다. 인증서·TLS 는 코드 모양이
 * 여러 가지라 접두사로 본다.
 */
const HINTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(ENOTFOUND|EAI_AGAIN|EAI_NONAME)$/, "주소를 찾지 못했습니다(DNS)"],
  [/^ECONNREFUSED$/, "상대가 연결을 거절했습니다"],
  [/^(ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)$/, "연결이 시간을 넘겼습니다"],
  [/^(UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/, "응답이 시간 안에 오지 않았습니다"],
  [/^(ECONNRESET|EPIPE|UND_ERR_SOCKET|ERR_SOCKET_CONNECTION_CLOSED)$/, "연결이 중간에 끊겼습니다"],
  [/^(EHOSTUNREACH|ENETUNREACH|ENETDOWN)$/, "그 주소로 가는 길이 없습니다"],
  [/^(CERT_|ERR_TLS_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_(GET|VERIFY))/, "인증서를 믿을 수 없습니다"],
];

/** 코드가 없어도 전송 실패로 봐야 하는 이름들. */
const TRANSPORT_NAMES = new Set(["TimeoutError", "AbortError", "ConnectTimeoutError", "SocketError"]);

/** 코드가 이 모양이면 전송 실패다. HINTS 에 없는 코드까지 받는다. */
const TRANSPORT_CODE = /^(E[A-Z]+|UND_ERR_|ERR_SOCKET|ERR_TLS|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_)/;

function readLink(value: unknown): Link | null {
  if (typeof value === "string") return { name: "", message: value, code: "" };
  if (value === null || typeof value !== "object") return null;
  const bag = value as {
    name?: unknown; message?: unknown; code?: unknown; errno?: unknown;
  };
  const code = typeof bag.code === "string"
    ? bag.code
    : typeof bag.errno === "string"
      ? bag.errno
      : "";
  return {
    name: typeof bag.name === "string" ? bag.name : "",
    message: typeof bag.message === "string" ? bag.message : "",
    code,
  };
}

/** cause 를 따라 내려가며 칸을 모은다. 깊은 쪽이 보통 더 구체적이다. */
function chainOf(error: unknown): Link[] {
  const links: Link[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (current === null || current === undefined) break;
    if (typeof current === "object") {
      if (seen.has(current)) break; // 순환. undici 가 cause 를 되걸어 둔 경우가 있다.
      seen.add(current);
    }
    const link = readLink(current);
    if (link === null) {
      links.push({ name: "", message: String(current), code: "" });
      break;
    }
    links.push(link);
    // AggregateError(여러 주소를 시도한 경우)는 cause 대신 errors 를 들고 있다.
    const next = (current as { cause?: unknown; errors?: unknown }).cause
      ?? (Array.isArray((current as { errors?: unknown }).errors)
        ? ((current as { errors: unknown[] }).errors[0])
        : undefined);
    current = next;
  }

  return links;
}

function hintFor(code: string): string {
  for (const [pattern, phrase] of HINTS) {
    if (pattern.test(code)) return phrase;
  }
  return "연결이 깨졌습니다";
}

/**
 * 오류 하나를 "사유 · 코드 · 다시 보내도 되는가" 로 읽는다.
 *
 * 전송 실패가 아니면(우리가 만든 오류, 서버가 거절한 것 등) 메시지를 그대로 돌려준다 —
 * 그쪽은 이미 사람이 읽을 문장이다.
 */
export function readFetchFailure(error: unknown): FetchFailure {
  const links = chainOf(error);
  if (links.length === 0) {
    return { message: "사유를 알 수 없는 오류입니다.", code: "", transport: false };
  }

  const top = links[0] as Link;
  const code = links.find((l) => l.code !== "")?.code ?? "";
  const transport =
    links.some((l) => TRANSPORT_NAMES.has(l.name))
    || (code !== "" && TRANSPORT_CODE.test(code))
    // undici 의 껍데기. cause 가 비어 있어도(드물다) 전송 실패인 것은 분명하다.
    || /^fetch failed$/i.test(top.message);

  if (!transport) {
    return { message: top.message.slice(0, MAX_MESSAGE), code, transport: false };
  }

  // 깊은 쪽의 메시지가 구체적이다("connect ETIMEDOUT 10.0.0.1:443"). 껍데기는 버린다.
  const detail = links
    .map((l) => l.message)
    .filter((m) => m !== "" && !/^fetch failed$/i.test(m))
    .pop() ?? "";

  const phrase = hintFor(code);
  const tail = detail === ""
    ? code === "" ? "사유를 알 수 없습니다" : code
    : code !== "" && !detail.includes(code) ? `${detail} (${code})` : detail;

  return { message: `${phrase}: ${tail}`.slice(0, MAX_MESSAGE), code, transport: true };
}

/** 사유 한 줄만 필요할 때. 화면·로그·감사 기록에 그대로 쓴다. */
export function describeFetchError(error: unknown): string {
  return readFetchFailure(error).message;
}
