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
import { readFetchFailure } from "./fetchFailure.ts";

export const FTP_ORIGIN = "https://supportftp.broadcom.com";
/** 고객이 올리는 파일이 들어가는 폴더. 루트에는 쓰기 권한이 없다. */
export const UPLOAD_FOLDER = "files_from_customer";
/** 리다이렉트를 따라갈 최대 횟수. OAuth 왕복이 서너 번이라 넉넉히 둔다. */

/**
 * 올리기 실패의 종류.
 *
 *   session     세션이 거절됐다 — 다시 로그인해야 한다
 *   rejected    서버가 판단해서 거절했다 — 다시 보내도 같다
 *   mismatch    올렸다는데 폴더에 **없다** — 올라가지 않았다
 *   transport   말이 닿지 않았다(연결·DNS·시간초과) — **다시 보내 볼 수 있다**
 *   unverified  올라갔는데 **확인만** 못 했다 — 다시 보내면 중복이다
 *
 * transport 와 unverified 를 가르는 것이 요점이다. 둘 다 "전송이 깨졌다" 지만 깨진
 * 시점이 PUT **전**인지 **후**인지가 다르고, 그에 따라 다시 보내도 되는지가 뒤집힌다.
 */
export type UploadErrorCode = "session" | "rejected" | "mismatch" | "transport" | "unverified";

export class UploadError extends Error {
  readonly code: UploadErrorCode;
  constructor(code: UploadErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "UploadError";
  }
}

/**
 * 명령(getXMLListing 등) 한 건의 상한. 본문이 없는 짧은 요청이라 넉넉하다.
 * 레포의 다른 외부 호출과 같은 값이다(lib/atlassian.ts, lib/confluencePublish.ts).
 */
export const COMMAND_TIMEOUT_MS = 45_000;

/**
 * 올리기 한 건의 상한 — **크기에 비례해서** 잡는다.
 *
 * 고정값으로는 맞출 수 없다. 50KB 로그와 50MB 번들이 같은 경로로 가고, 실측 처리량은
 * 사내망·VPN 을 거쳐 **초당 600KB 남짓**이었다(5.6MB 업로드가 9초). 고정 60초면 큰
 * 파일이 멀쩡히 올라가는 중에 끊기고, 고정 10분이면 죽은 연결을 10분 붙잡는다.
 *
 * 그래서 60초 + 100KB 당 1초, 상한은 아래 예산과 같게 둔다.
 */
export function uploadTimeoutMs(bytes: number): number {
  return Math.min(UPLOAD_BUDGET_MS, 60_000 + Math.ceil(bytes / (100 * 1024)) * 1_000);
}

/**
 * 한 건에 쓸 **전체** 시간 — 재시도를 다 합쳐서.
 *
 * 시도마다 상한을 거는 것으로는 모자란다. 50MB 짜리가 세 번 시간초과하면 24분인데,
 * worker 는 첨부 프로세스를 **600초에 죽인다**(collector/worker.ts 의
 * ATTACHMENTS_TIMEOUT_MS). 그러면 우리가 적어 둔 사유 대신 그 행이 `running` 으로
 * 남아 아무도 끝내주지 않고, 사람은 되살아날 때까지(15분) "처리 중" 만 본다.
 *
 * 420초로 둔다. 남은 180초는 브라우저 기동(10초)·케이스 진입(6초)과 한 회차에 같이
 * 들어온 다른 건들의 몫이다.
 */
const UPLOAD_BUDGET_MS = 420_000;

/**
 * PUT 을 다시 보내 볼 횟수(처음 시도 포함).
 *
 * **여기서는 재시도가 안전하다.** 목적지가 고정 경로이고 본문이 같아서, 두 번 보내면
 * 덮어쓰기가 된다 — 케이스에 파일이 두 개 붙지 않는다. 화면의 POST 를 자동 재시도하지
 * 않는 것과 정반대인데(그쪽은 큐에 이미 들어갔을 수 있어 중복이 된다), 지금까지
 * **재시도가 안전한 유일한 구간에만 재시도가 없었다.**
 */
const UPLOAD_ATTEMPTS = 3;

/**
 * 재시도 사이 간격. 2초 → 6초. 끊긴 직후 바로 다시 걸면 대개 또 끊긴다.
 *
 * `SR_UPLOAD_RETRY_MS` 로 바꿀 수 있다. **테스트에서 0 으로 줄이기 위한 것**이다 —
 * 그렇지 않으면 재시도 한 번을 재는 데 8초를 기다린다. 운영에서 건드릴 이유는 없다.
 */
const RETRY_BASE_MS = (() => {
  // 빈 문자열을 Number() 에 넣으면 0 이다 — 안 준 것과 "0 을 줬다" 를 먼저 가른다.
  const given = (process.env.SR_UPLOAD_RETRY_MS ?? "").trim();
  if (given === "") return 2_000;
  const raw = Number(given);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2_000;
})();
const RETRY_BACKOFF_MS = [RETRY_BASE_MS, RETRY_BASE_MS * 3] as const;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * fetch 한 번. 전송이 깨지면 **사유를 담은** UploadError 로 바꿔 던진다.
 *
 * 그대로 올려 보내면 호출부(collector/attachments.ts)가 `error.message` 를 적는데,
 * undici 의 그 값은 "fetch failed" 넉 자뿐이다. 사유는 cause 사슬에 있다
 * (lib/fetchFailure.ts 머리말 — 이 네 글자 때문에 첨부 실패 한 건을 끝까지 못 읽었다).
 */
async function send(url: URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const failure = readFetchFailure(error);
    if (!failure.transport) throw error;
    throw new UploadError("transport", failure.message);
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
  const response = await send(url, {
    method: "POST",
    headers: { ...API_HEADERS, ...(cookie === "" ? {} : { Cookie: cookie }) },
    body: form,
  }, COMMAND_TIMEOUT_MS);
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
  /**
   * 몇 번째 시도에 성공했는가. 1 이면 한 번에 됐다.
   *
   * 호출부가 **로그에 남기도록** 돌려준다. 조용히 두 번 보내면 다음 사람이 "왜 느린가"
   * 를 처음부터 조사한다. 2 이상이 자주 보이면 망 쪽을 봐야 한다는 신호다.
   */
  readonly attempts: number;
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
 *
 * ## 전송이 깨졌을 때 (2026-11-17 에 겪은 것)
 *
 * 전에는 이 함수의 fetch 가 맨몸이었다 — 상한도, 재시도도 없었다. 그래서 연결이 깨지면
 * undici 의 `TypeError: fetch failed` 가 그대로 작업 행에 적히고, 화면에는
 * `KakaoTalk_….jpg: fetch failed` 만 떴다. 사유도 모르고 다시 보내 보지도 않았다.
 *
 * 지금은 셋을 나눠 다룬다.
 *
 *   PUT 중에 깨짐          → 사유를 읽어(lib/fetchFailure.ts) 최대 3번까지 다시 보낸다.
 *                            같은 경로에 덮어쓰므로 중복이 생기지 않는다.
 *   확인(목록) 중에 깨짐   → **실패가 아니다.** 파일은 이미 올라갔다. `unverified` 로
 *                            올려 보내 호출부가 성공으로 끝내게 한다 — 여기서 실패로
 *                            적으면 사람이 다시 올려 케이스에 같은 파일이 두 번 붙고,
 *                            게다가 우리 사본이 지워진다(lib/attachmentJobs.ts finishJob).
 *   목록에 파일이 없음     → 진짜 실패다(mismatch). 올라가지 않았다.
 *
 * ## 아직 확인하지 못한 용의자 (다음에 또 깨지면 여기부터)
 *
 * 이 PUT 은 `API_HEADERS` 를 그대로 싣는다. 그 안에는 **포털(Wolken)의 Origin·Referer**
 * 가 들어 있다(lib/config.ts — Wolken API 가 Origin 을 검증해서 넣은 것이다). CrushFTP
 * 에는 쓸 이유가 없는 헤더이고, 중간의 WAF 가 **다른 출처에서 온 큰 바이너리 PUT** 을
 * 보고 상태코드 대신 연결을 끊는 일이 실제로 흔하다 — 그러면 지금 증상(ECONNRESET
 * 계열의 전송 실패)과 모양이 같다.
 *
 * 그렇다고 지금 빼지는 않았다. 이 헤더로 **올라간 적이 있고**(files_from_customer 가
 * 여덟 시간 만에 비워진 것을 실측했다), 도는 길을 근거 없이 건드리면 무엇이 고쳐졌는지
 * 알 수 없게 된다. 새 사유 기록(lib/fetchFailure.ts)이 ECONNRESET 을 가리키면 그때
 * 이 헤더를 PUT 에서만 빼고 한 번 더 재면 된다.
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
  const startedAt = Date.now();
  const spent = (): number => Date.now() - startedAt;

  let said = "";
  let attempts = 0;
  for (;;) {
    attempts += 1;
    // 남은 예산 안에서만 기다린다. 재시도까지 합쳐 worker 가 죽이는 시각을 넘기면
    // 사유가 아무 데도 안 남는다(UPLOAD_BUDGET_MS 주석).
    // 0 이나 음수를 AbortSignal.timeout 에 넘기면 터진다. 아래 roomLeft 가 그 지점에
    // 도달하지 못하게 막지만, 상한 계산이 바뀌어도 안 터지도록 바닥을 둔다.
    const timeout = Math.max(1_000, Math.min(uploadTimeoutMs(total), UPLOAD_BUDGET_MS - spent()));
    try {
      // 쿠키는 시도마다 다시 읽는다. 앞선 응답이 쿠키를 갱신했을 수 있다.
      const cookie = jar.header(target);
      const response = await send(target, {
        method: "PUT",
        headers: {
          ...API_HEADERS,
          "content-type": "application/octet-stream",
          "content-length": String(total),
          ...(cookie === "" ? {} : { Cookie: cookie }),
        },
        body: options.bytes as unknown as BodyInit,
      }, timeout);
      jar.apply(response.headers.getSetCookie(), target);
      // `\s+` 다. 한때 백슬래시가 빠진 `/s+/` 여서 **알파벳 s 를 공백으로 바꾸고** 있었다
      // ("session expired" → " e  ion expired"). 실패 메시지가 그대로 사람에게 간다.
      said = (await response.text()).replace(/\s+/g, " ").trim();

      if (response.status === 401 || response.status === 403) {
        throw new UploadError("session", `첨부 서버가 거부했습니다 (HTTP ${response.status}). 다시 로그인하세요.`);
      }
      if (!response.ok) {
        throw new UploadError("rejected", `올리지 못했습니다 (HTTP ${response.status}). ${said.slice(0, 160)}`);
      }
      break;
    } catch (error) {
      const retryable = error instanceof UploadError && error.code === "transport";
      const backoff = RETRY_BACKOFF_MS[attempts - 1];
      // 다시 보낼 시간이 남아 있는가. 한 번 더 걸었다가 예산 밖에서 끊기면 그 사유도
      // 못 남긴다 — 그럴 바에는 지금까지 알아낸 사유를 들고 끝내는 편이 낫다.
      const roomLeft = backoff !== undefined
        && spent() + backoff + uploadTimeoutMs(total) <= UPLOAD_BUDGET_MS;
      if (!retryable || attempts >= UPLOAD_ATTEMPTS || backoff === undefined || !roomLeft) {
        // 마지막 시도까지 전송이 깨졌으면 **몇 번 해봤는지도 말한다.** 한 번 끊긴 것과
        // 세 번 내리 끊긴 것은 조사할 곳이 다르다.
        if (retryable) {
          throw new UploadError("transport", `${(error as UploadError).message} — ${attempts}번 시도했습니다.`);
        }
        throw error;
      }
      await sleep(backoff);
    }
  }

  // 올라갔는지 실제로 본다. 200 을 주고도 저장하지 않는 경우가 있었다.
  const folder = path.slice(0, path.lastIndexOf("/") + 1);
  let listed: string;
  try {
    listed = await command(jar, {
      command: "getXMLListing",
      format: "JSONOBJ",
      path: folder,
      c2f,
    });
  } catch (error) {
    // 확인에 실패한 것뿐이다. **파일은 올라갔다** — 그렇게 말해야 한다(머리말).
    if (error instanceof UploadError && error.code === "transport") {
      throw new UploadError("unverified", `올렸지만 폴더를 확인하지 못했습니다(${error.message}). 포털에서 보이는지 확인하세요.`);
    }
    throw error;
  }
  const wanted = safeFileName(options.fileName);
  if (!listed.includes(`"${wanted}"`)) {
    throw new UploadError(
      "mismatch",
      `올렸는데 폴더에 보이지 않습니다. 포털에서 확인하세요. (응답: ${said.slice(0, 80) || "(빈 응답)"})`,
    );
  }

  return { path, bytes: total, chunks: 1, md5: "", attempts };
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
