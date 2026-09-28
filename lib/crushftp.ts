/**
 * Broadcom 케이스에 첨부를 올린다.
 *
 * 첨부는 **포털(Wolken)이 아니라 supportftp.broadcom.com(CrushFTP)** 으로 간다.
 * 캡처 361건을 확인한 결과, 업로드 뒤 포털로 나가는 요청이 한 건도 없다. 그래서
 * lib/reply.ts 의 `"fileAttach": []` 는 이 경로와 무관하게 비어 있는 것이 맞다.
 *
 * ## 흐름
 *
 *   GET  /WebInterface/redirect.html?site=<site>&case=<case>
 *          → access.broadcom.com OAuth → /_codexch → 302 /<site>/<case>/
 *   POST /WebInterface/function/  command=openFile
 *   POST /U/<uploadId>~<n>~<len>  ← 조각. 1부터. 본문은 **날바이트**
 *   POST /WebInterface/function/  command=closeFile  → 응답에 md5
 *
 * ## 두 가지를 문서에서 확인했다 (추측하지 않았다)
 *
 * - 조각 본문은 멀티파트가 아니라 **날바이트**다. 브라우저 업로더는 멀티파트로 감싸지만
 *   API 가 받는 것은 본문 그대로다. 그래서 필드 이름이라는 것이 없다.
 * - `c2f` 는 상수가 아니라 **CrushAuth 쿠키의 마지막 4글자**다. 캡처에서 늘 같은 값이라
 *   상수로 볼 뻔했는데, 그랬으면 다른 세션에서 조용히 실패했을 것이다.
 *   https://www.crushftp.com/crush11wiki/Wiki.jsp?page=APIFileTransfer
 *
 * ## 세션은 케이스 단위로 묶인다
 *
 * getUsername 응답이 `…,^<site>^<case>^` 를 돌려준다. 쿠키만 있다고 올릴 수 있는 것이
 * 아니라 반드시 redirect.html 을 먼저 거쳐야 한다.
 */
import { createHash } from "node:crypto";
import { CookieJar } from "../collector/cookieJar.ts";
import { API_HEADERS } from "./config.ts";
import { isAllowedHost } from "./attachmentSource.ts";

export const FTP_ORIGIN = "https://supportftp.broadcom.com";
/** 고객이 올리는 파일이 들어가는 폴더. 루트에는 쓰기 권한이 없다. */
export const UPLOAD_FOLDER = "files_from_customer";
/** 조각 크기. 실측 브라우저가 쓰는 값과 같다(문서 상한은 10MB). */
export const CHUNK_BYTES = 512 * 1024;
/** 리다이렉트를 따라갈 최대 횟수. OAuth 왕복이 서너 번이라 넉넉히 둔다. */
const MAX_HOPS = 8;

export class UploadError extends Error {
  readonly code: "session" | "rejected" | "mismatch";
  constructor(code: "session" | "rejected" | "mismatch", message: string) {
    super(message);
    this.code = code;
    this.name = "UploadError";
  }
}

/**
 * 파일명에서 경로를 걷어낸다.
 *
 * 올릴 경로에 그대로 들어가므로 `..` 이나 구분자가 남으면 남의 폴더에 쓸 수 있다.
 * 이름만 남기고, 남는 것이 없으면 거부한다.
 */
export function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f]/g, "").trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    throw new UploadError("rejected", "파일 이름을 알 수 없습니다.");
  }
  return cleaned;
}

/** 올릴 자리. site 와 case 는 숫자만 받는다 — 경로에 그대로 들어간다. */
export function uploadPathFor(site: string, caseId: number, fileName: string): string {
  if (!/^\d+$/.test(site)) {
    throw new UploadError("rejected", `고객사 번호가 올바르지 않습니다: ${site}`);
  }
  if (!Number.isSafeInteger(caseId) || caseId <= 0) {
    throw new UploadError("rejected", `케이스 번호가 올바르지 않습니다: ${caseId}`);
  }
  return `/${site}/${caseId}/${UPLOAD_FOLDER}/${safeFileName(fileName)}`;
}

/**
 * c2f 토큰. CrushAuth 쿠키의 마지막 4글자다.
 *
 * 없으면 세션이 아직 CrushFTP 로 붙지 않은 것이다 — 올리기 전에 알아야 한다.
 * 여기서 걸러야 "권한 없음" 이 아니라 "다시 로그인하세요" 라고 말할 수 있다.
 */
export function c2fFrom(jar: CookieJar): string {
  const cookie = jar.snapshot().find(
    (c) => c.name === "CrushAuth" && /supportftp\.broadcom\.com$/i.test(c.domain.replace(/^\./, "")),
  );
  const value = cookie?.value ?? "";
  if (value.length < 4) {
    throw new UploadError("session", "첨부 서버 세션이 없습니다. 다시 로그인하세요.");
  }
  return value.slice(-4);
}

/** 조각 경계. 마지막 조각만 작다. */
export function chunkRanges(total: number, size = CHUNK_BYTES): Array<{ start: number; end: number }> {
  if (total <= 0) throw new UploadError("rejected", "빈 파일은 올리지 않습니다.");
  const out: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < total; start += size) {
    out.push({ start, end: Math.min(start + size, total) });
  }
  return out;
}

/** CrushFTP 가 돌려주는 XML 한 겹을 벗긴다. 실패면 null. */
export function readCommandResult(xml: string): string | null {
  const m = /<response>([\s\S]*?)<\/response>/i.exec(xml);
  return m === null ? null : (m[1] ?? "").trim();
}

/** closeFile 응답의 md5. 없으면 null. */
export function readMd5(xml: string): string | null {
  const m = /<md5>([0-9a-f]{32})<\/md5>/i.exec(xml);
  return m === null ? null : (m[1] ?? "").toLowerCase();
}

/**
 * 리다이렉트를 쿠키 단지를 들고 따라간다.
 *
 * fetch 의 redirect:"follow" 는 단지를 모른다. supportftp 는 세션이 없으면 OAuth 로
 * 튕기고, 그 왕복에서 받은 쿠키를 다음 홉에 실어야 돌아올 수 있다.
 */
async function followWithJar(jar: CookieJar, start: string): Promise<Response> {
  let url = start;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const at = new URL(url);
    if (!isAllowedHost(at.hostname)) {
      throw new UploadError("rejected", `허용하지 않는 호스트입니다: ${at.hostname}`);
    }
    const cookie = jar.header(at);
    const response = await fetch(url, {
      headers: { ...API_HEADERS, ...(cookie === "" ? {} : { Cookie: cookie }) },
      redirect: "manual",
    });
    jar.apply(response.headers.getSetCookie(), at);

    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location === null) return response;
    url = new URL(location, at).toString();
  }
  throw new UploadError("session", "첨부 서버 로그인이 끝나지 않았습니다.");
}

/** /WebInterface/function/ 에 명령 하나. 실측 트래픽과 같은 multipart 로 보낸다. */
async function command(
  jar: CookieJar,
  fields: Record<string, string>,
): Promise<string> {
  const url = new URL(`${FTP_ORIGIN}/WebInterface/function/`);
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  // 캐시 회피. 브라우저도 매 요청에 붙인다.
  form.append("random", String(Math.random()));

  const cookie = jar.header(url);
  const response = await fetch(url, {
    method: "POST",
    headers: { ...API_HEADERS, ...(cookie === "" ? {} : { Cookie: cookie }) },
    body: form,
  });
  jar.apply(response.headers.getSetCookie(), url);
  if (response.status === 401 || response.status === 403) {
    throw new UploadError("session", "첨부 서버가 세션을 거부했습니다. 다시 로그인하세요.");
  }
  if (!response.ok) {
    throw new UploadError("rejected", `첨부 서버 오류 (HTTP ${response.status}).`);
  }
  return await response.text();
}

/**
 * getUsername 응답에서 세션이 묶인 케이스 번호를 뽑는다.
 *
 * 응답의 username 은 `<계정>,^<site>^<case>^` 이고 URL 인코딩되어 온다(^ → %5E).
 * 모르면 null — "아니다" 와 구분해야 한다.
 */
export function boundCaseOf(xml: string): number | null {
  const name = /<username>([^<]*)<\/username>/i.exec(xml)?.[1] ?? "";
  const decoded = (() => {
    try { return decodeURIComponent(name); } catch { return name; }
  })();
  const m = /\^\d+\^(\d+)\^/.exec(decoded);
  return m === null ? null : Number(m[1]);
}

/** CrushFTP 세션을 끊는다. 다른 케이스로 다시 묶으려면 먼저 나가야 한다. */
async function logout(jar: CookieJar): Promise<void> {
  const url = new URL(`${FTP_ORIGIN}/WebInterface/function/`);
  url.searchParams.set("command", "logout");
  url.searchParams.set("random", String(Math.random()));
  try {
    url.searchParams.set("c2f", c2fFrom(jar));
  } catch {
    return; // 애초에 세션이 없으면 나갈 것도 없다
  }
  const cookie = jar.header(url);
  const response = await fetch(url, {
    headers: { ...API_HEADERS, ...(cookie === "" ? {} : { Cookie: cookie }) },
    redirect: "manual",
  });
  jar.apply(response.headers.getSetCookie(), url);
}

/**
 * 그 케이스로 세션을 묶는다. 올리기 전에 반드시 거쳐야 한다.
 *
 * **CrushFTP 세션은 한 번에 케이스 하나에만 묶인다.** getUsername 이
 * `<계정>,^<site>^<case>^` 를 돌려주는데, 이미 다른 케이스로 묶여 있으면
 * redirect.html 을 다시 불러도 302 없이 200 만 돌아오고 묶임이 바뀌지 않는다.
 * 실측으로 확인했다 — 캡처에 logout 호출이 있었던 이유가 이것이다.
 * 그래서 어긋나면 한 번 나갔다가 다시 묶는다.
 *
 * 로그인 화면이 200 으로 돌아오는 경우가 있어 상태 코드만으로는 모자라다.
 * 반드시 getUsername 으로 확인한다.
 */
export async function openCaseSession(
  jar: CookieJar,
  site: string,
  caseId: number,
): Promise<void> {
  if (!/^\d+$/.test(site)) {
    throw new UploadError("rejected", `고객사 번호가 올바르지 않습니다: ${site}`);
  }
  const enter = `${FTP_ORIGIN}/WebInterface/redirect.html?site=${site}&case=${caseId}`;

  await followWithJar(jar, enter);
  let xml = await command(jar, { command: "getUsername", c2f: c2fFrom(jar) });

  // 다른 케이스로 묶여 있으면 나갔다가 다시 들어온다.
  if (boundCaseOf(xml) !== caseId) {
    await logout(jar);
    await followWithJar(jar, enter);
    xml = await command(jar, { command: "getUsername", c2f: c2fFrom(jar) });
  }

  if (!/<response>\s*success\s*<\/response>/i.test(xml)) {
    throw new UploadError("session", "첨부 서버에 로그인되어 있지 않습니다. 다시 로그인하세요.");
  }
  const bound = boundCaseOf(xml);
  if (bound !== caseId) {
    throw new UploadError(
      "rejected",
      bound === null
        ? `첨부 서버가 케이스를 알려주지 않았습니다. 다시 로그인하세요.`
        : `세션이 다른 케이스(${bound})에 묶여 있습니다. 다시 로그인하세요.`,
    );
  }
}

export interface UploadResult {
  /** 올라간 전체 경로. */
  readonly path: string;
  readonly bytes: number;
  readonly chunks: number;
  /** 서버가 돌려준 md5. 우리가 계산한 것과 대조해 통과한 값이다. */
  readonly md5: string;
}

/**
 * 파일 하나를 올린다.
 *
 * 서버가 돌려준 md5 를 우리가 계산한 것과 **대조한다.** 조각이 하나라도 어긋나면
 * 손상된 파일이 케이스에 남는데, 사람은 그걸 알 방법이 없다.
 */
export async function uploadToCase(
  jar: CookieJar,
  options: { site: string; caseId: number; fileName: string; bytes: Uint8Array },
): Promise<UploadResult> {
  const path = uploadPathFor(options.site, options.caseId, options.fileName);
  const total = options.bytes.byteLength;
  const ranges = chunkRanges(total);
  const c2f = c2fFrom(jar);
  // 브라우저가 쓰는 모양(영숫자 소문자)을 따른다. 서버는 우리가 정한 값을 그대로 쓴다.
  const uploadId = `sr${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  await command(jar, {
    command: "openFile",
    c2f,
    upload_path: path,
    upload_size: String(total),
    upload_id: uploadId,
    start_resume_loc: "0",
  });

  for (const [index, range] of ranges.entries()) {
    const body = options.bytes.subarray(range.start, range.end);
    const url = new URL(`${FTP_ORIGIN}/U/${uploadId}~${index + 1}~${body.byteLength}`);
    const cookie = jar.header(url);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...API_HEADERS,
        // 조각은 날바이트다. 멀티파트로 감싸지 않는다.
        "content-type": "application/octet-stream",
        ...(cookie === "" ? {} : { Cookie: cookie }),
      },
      body: body as unknown as BodyInit,
    });
    jar.apply(response.headers.getSetCookie(), url);
    if (!response.ok) {
      throw new UploadError(
        "rejected",
        `${index + 1}/${ranges.length} 번째 조각을 올리지 못했습니다 (HTTP ${response.status}).`,
      );
    }
  }

  const closed = await command(jar, {
    command: "closeFile",
    c2f,
    upload_id: uploadId,
    total_chunks: String(ranges.length),
    total_bytes: String(total),
    filePath: path,
    lastModified: String(Date.now()),
  });

  const md5 = readMd5(closed);
  const mine = createHash("md5").update(options.bytes).digest("hex");
  if (md5 === null) {
    throw new UploadError("mismatch", "서버가 파일 확인값을 돌려주지 않았습니다. 포털에서 확인하세요.");
  }
  if (md5 !== mine) {
    throw new UploadError("mismatch", "올라간 파일이 원본과 다릅니다. 다시 시도하세요.");
  }

  return { path, bytes: total, chunks: ranges.length, md5 };
}
