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
 *   PUT  /<site>/<case>/files_from_customer/<이름>   ← 올리기. 본문이 곧 파일이다
 *   POST /WebInterface/function/  command=getXMLListing  ← 올라갔는지 눈으로 확인
 *
 * ## 두 가지를 문서에서 확인했다 (추측하지 않았다)
 *
 * - 올리기는 **PUT 한 번**이면 된다. 처음에는 브라우저가 쓰는 조각 방식을 흉내 냈는데
 *   실제로는 파일이 올라가지 않았다(uploadToCase 머리말 참고).
 * - `c2f` 는 상수가 아니라 **CrushAuth 쿠키의 마지막 4글자**다. 캡처에서 늘 같은 값이라
 *   상수로 볼 뻔했는데, 그랬으면 다른 세션에서 조용히 실패했을 것이다.
 *   https://www.crushftp.com/crush11wiki/Wiki.jsp?page=APIFileTransfer
 *
 * ## 세션은 케이스 단위로 묶인다
 *
 * getUsername 응답이 `…,^<site>^<case>^` 를 돌려준다. 쿠키만 있다고 올릴 수 있는 것이
 * 아니라 반드시 redirect.html 을 먼저 거쳐야 한다. 그 이동은 자바스크립트가 하므로
 * **브라우저가 있어야 한다** — 그래서 케이스 진입은 여기가 아니라 수집기가 맡는다
 * (collector/attachments.ts 의 enterCase). 여기 남은 것은 진입이 끝난 뒤 쓰는 것들이다.
 */
import { CookieJar } from "../collector/cookieJar.ts";
import { API_HEADERS } from "./config.ts";
import { isAllowedHost } from "./attachmentSource.ts";

export const FTP_ORIGIN = "https://supportftp.broadcom.com";
/** 고객이 올리는 파일이 들어가는 폴더. 루트에는 쓰기 권한이 없다. */
export const UPLOAD_FOLDER = "files_from_customer";
/** 리다이렉트를 따라갈 최대 횟수. OAuth 왕복이 서너 번이라 넉넉히 둔다. */

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
 * **PUT 한 번이다.** 처음에는 브라우저가 쓰는 방식(openFile → 조각 → closeFile)을
 * 그대로 흉내 냈는데, 실제로 돌려 보니 파일이 올라가지 않았다. 조각 본문이
 * multipart 인지 날바이트인지 문서가 말하지 않고, 브라우저는 multipart 로 보냈지만
 * 필드 이름은 캡처에 안 잡혔다(Playwright 가 512KB 본문을 안 내준다). 추측해서
 * 맞출 문제가 아니었다.
 *
 * 문서에 훨씬 단순한 길이 있다 — 목적지 경로로 PUT 하면 끝이다.
 *
 *     curl -T KB2.txt -u user:pass http://127.0.0.1:8080/KB2.txt
 *
 * 필드 이름을 추측할 일도, 조각 경계를 맞출 일도 없다.
 * https://www.crushftp.com/crush11wiki/Wiki.jsp?page=APIFileTransfer
 *
 * **올린 뒤 폴더를 읽어 확인한다.** 서버가 200 을 주고도 아무것도 저장하지 않는 일을
 * 실제로 겪었다. 이름과 크기가 목록에 보여야 성공으로 본다 — md5 를 믿는 것보다 확실하다.
 */
export async function uploadToCase(
  jar: CookieJar,
  options: { site: string; caseId: number; fileName: string; bytes: Uint8Array },
): Promise<UploadResult> {
  const path = uploadPathFor(options.site, options.caseId, options.fileName);
  const total = options.bytes.byteLength;
  if (total === 0) throw new UploadError("rejected", "빈 파일은 올리지 않습니다.");
  const c2f = c2fFrom(jar);

  const target = new URL(`${FTP_ORIGIN}${path.split("/").map(encodeURIComponent).join("/")}`);
  const cookie = jar.header(target);
  const response = await fetch(target, {
    method: "PUT",
    headers: {
      ...API_HEADERS,
      "content-type": "application/octet-stream",
      "content-length": String(total),
      ...(cookie === "" ? {} : { Cookie: cookie }),
    },
    body: options.bytes as unknown as BodyInit,
  });
  jar.apply(response.headers.getSetCookie(), target);
  const said = (await response.text()).replace(/s+/g, " ").trim();

  if (response.status === 401 || response.status === 403) {
    throw new UploadError("session", `첨부 서버가 거부했습니다 (HTTP ${response.status}). 다시 로그인하세요.`);
  }
  if (!response.ok) {
    throw new UploadError("rejected", `올리지 못했습니다 (HTTP ${response.status}). ${said.slice(0, 160)}`);
  }

  // 올라갔는지 실제로 본다. 200 을 주고도 저장하지 않는 경우가 있었다.
  const folder = path.slice(0, path.lastIndexOf("/") + 1);
  const listed = await command(jar, {
    command: "getXMLListing",
    format: "JSONOBJ",
    path: folder,
    c2f,
  });
  const wanted = safeFileName(options.fileName);
  if (!listed.includes(`"${wanted}"`)) {
    throw new UploadError(
      "mismatch",
      `올렸는데 폴더에 보이지 않습니다. 포털에서 확인하세요. (응답: ${said.slice(0, 80) || "(빈 응답)"})`,
    );
  }

  return { path, bytes: total, chunks: 1, md5: "" };
}

/* ------------------------------------------------------------------ *
 * 첨부 위치 읽기
 * ------------------------------------------------------------------ */

export interface FtpFileRef {
  readonly site: string;
  readonly caseId: number;
  /** 사이트 루트 기준 경로. 예: 15588968/36416271/files_from_customer/om_restore.sh */
  readonly path: string;
}

/**
 * 저장된 doc_path 에서 첨부의 실제 위치를 뽑는다.
 *
 * 포털이 주는 링크는 파일이 아니라 **JS 로 이동시키는 페이지**다.
 *
 *   https://supportftp.broadcom.com/WebInterface/redirect.html?filePath=<site>/<case>/files_from_customer/<이름>
 *
 * 그래서 fetch 로 그 주소를 받으면 파일이 아니라 HTML 이 온다 — 첨부 다운로드가
 * 안 되던 이유다. filePath 만 떼어 내면 실물은 사이트 루트 아래 그 경로에 있다.
 *
 * 모양이 다르면 null. 추측해서 경로를 만들지 않는다.
 */
export function parseFilePath(docPath: string): FtpFileRef | null {
  let url: URL;
  try {
    url = new URL(docPath.trim());
  } catch {
    return null;
  }
  if (!isAllowedHost(url.hostname)) return null;

  const raw = url.searchParams.get("filePath") ?? "";
  const path = raw.replace(/^\/+/, "");
  if (path === "") return null;
  // 경로 이탈을 막는다. 사이트 루트 밖으로 나가는 요청을 만들지 않는다.
  if (path.split("/").some((part) => part === "." || part === "..")) return null;

  const [site, caseText] = path.split("/");
  if (site === undefined || !/^\d+$/.test(site)) return null;
  if (caseText === undefined || !/^\d+$/.test(caseText)) return null;

  return { site, caseId: Number(caseText), path };
}

/** 그 첨부를 실제로 받아올 주소. */
export function fileUrlFor(ref: FtpFileRef): string {
  return `${FTP_ORIGIN}/${ref.path.split("/").map(encodeURIComponent).join("/")}`;
}
