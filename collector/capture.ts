/**
 * 포털 요청 캡처.
 *
 * 저장된 세션으로 브라우저를 띄운다. 사람이 원하는 화면까지 이동하면
 * 그 사이 오간 API 요청과 응답을 파일로 남긴다.
 * 화면 라우트나 payload 를 추측하지 않고 실제 트래픽에서 확인하기 위한 도구다.
 *
 *   npm run capture
 *
 * 창을 닫으면 저장하고 종료한다.
 *
 * 첨부 업로드처럼 multipart 로 나가는 요청은 postData() 가 null 이라
 * 본문을 따로 뜯어 필드 이름만 남긴다. 파일 내용(바이트)은 저장하지 않는다 —
 * 우리가 알아야 할 것은 "어떤 필드에 무엇을 담아 보내는가"뿐이다.
 */
import { loadEnv } from "../lib/env.ts";
loadEnv();

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Request, Response } from "playwright";
import { NAV_TIMEOUT_MS, PORTAL_HOME, SESSION_FILE } from "../lib/config.ts";
import { launchBrowser } from "./session.ts";

const OUT_DIR = resolve("data/captured");
const POLL_MS = 2000;
const MAX_WAIT_MS = 60 * 60 * 1000;

/** 화면을 그리는 정적 자원과 텔레메트리는 걸러낸다. */
const SKIP =
  /[.](js|css|woff2?|ttf|png|jpe?g|gif|svg|ico|map)([?]|$)|google-analytics|googletagmanager|doubleclick|fonts[.]g|\/assets\/|\/i18n\/|ext_data_push|flex_mapping_events/i;

/** 볼 만한 호스트. 첨부 파일은 포털이 아니라 supportftp / BOX 로 오간다. */
const HOSTS = /wolkenservicedesk\.com|supportftp\.broadcom\.com|box\.com|boxcloud\.com/i;

interface Captured {
  index: number;
  method: string;
  url: string;
  status: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  postData: string | null;
  /** multipart 일 때 파트 이름과 파일명만. 바이트는 담지 않는다. */
  multipartParts: string[] | null;
  response: string;
}

const captured: Captured[] = [];

/** 우리가 실제로 필요한 헤더만 남긴다. 쿠키·토큰은 저장하지 않는다. */
function pickHeaders(all: Record<string, string>): Record<string, string> {
  const keep = ["content-type", "content-length", "content-disposition", "location", "accept", "origin", "referer"];
  const out: Record<string, string> = {};
  for (const key of keep) {
    const value = all[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * multipart 본문에서 파트 이름과 파일명만 뽑는다.
 *
 * 파일 바이트가 섞여 있으므로 latin1 로 읽어 헤더 줄만 훑는다.
 * 작은 텍스트 파트는 값도 같이 남긴다 — moduleId 같은 게 여기 들어온다.
 */
function describeMultipart(buffer: Buffer): string[] {
  const text = buffer.toString("latin1");
  const parts: string[] = [];
  const pattern = /Content-Disposition:\s*form-data;([^\r\n]*)\r?\n([^\r\n]*)\r?\n\r?\n([\s\S]{0,200}?)\r?\n--/gi;

  let match = pattern.exec(text);
  while (match !== null) {
    const disposition = (match[1] ?? "").trim();
    const extraHeader = (match[2] ?? "").trim();
    const value = (match[3] ?? "").trim();
    const isFile = /filename=/i.test(disposition);
    const shown = isFile
      ? `<파일 ${buffer.length}B>`
      : value.slice(0, 160).replace(/[^\x20-\x7E가-힣]/g, "");
    parts.push(`${disposition}${extraHeader === "" ? "" : ` | ${extraHeader}`} => ${shown}`);
    match = pattern.exec(text);
  }
  return parts;
}

async function record(response: Response): Promise<void> {
  const url = response.url();
  if (SKIP.test(url)) return;
  if (!HOSTS.test(url)) return;

  const request: Request = response.request();
  const type = (response.headers()["content-type"] ?? "").toLowerCase();
  const textual = type.includes("json") || type.includes("text") || type.includes("xml");

  // 첨부 다운로드는 JSON 이 아니다. 본문 대신 헤더만 남겨도 경로 확인에는 충분하다.
  let body = "";
  if (textual) {
    try {
      body = await response.text();
    } catch {
      body = "";
    }
  } else {
    body = `<${type || "unknown"} ${response.headers()["content-length"] ?? "?"}B — 본문 생략>`;
  }

  let postData: string | null = null;
  let multipartParts: string[] | null = null;
  try {
    postData = request.postData();
  } catch {
    postData = null;
  }
  if (postData === null && request.method() !== "GET") {
    const buffer = request.postDataBuffer();
    if (buffer !== null) multipartParts = describeMultipart(buffer);
  }

  const index = captured.length + 1;
  captured.push({
    index,
    method: request.method(),
    url,
    status: response.status(),
    requestHeaders: pickHeaders(request.headers()),
    responseHeaders: pickHeaders(response.headers()),
    postData: postData === null ? null : postData.slice(0, 100_000),
    multipartParts,
    response: body.slice(0, 300_000),
  });

  const short = url.replace("https://api-broadcomcms-software.wolkenservicedesk.com", "");
  const mark = multipartParts !== null ? " [multipart]" : "";
  console.log(
    `  [${String(index).padStart(3, "0")}] ${request.method().padEnd(5)} ${response.status()} ` +
      `${String(body.length).padStart(8)}B  ${short.slice(0, 88)}${mark}`,
  );
}

function save(): void {
  mkdirSync(OUT_DIR, { recursive: true });

  for (const item of captured) {
    const tail = item.url.split("?")[0]?.replace(/\/+$/, "").split("/").pop() ?? "root";
    const name = tail.replace(/[^A-Za-z0-9]+/g, "_").slice(0, 40);
    writeFileSync(
      resolve(OUT_DIR, `${String(item.index).padStart(3, "0")}_${name}.json`),
      JSON.stringify(item, null, 2),
      "utf8",
    );
  }

  const index = captured
    .map((c) => `${String(c.index).padStart(3, "0")} | ${c.method.padEnd(5)} | ${c.status} | ${c.url}`)
    .join("\n");
  writeFileSync(resolve(OUT_DIR, "_index.txt"), index, "utf8");
}

async function main(): Promise<void> {
  const browser = await launchBrowser(false);
  const context = await browser.newContext({
    storageState: resolve(SESSION_FILE),
    viewport: { width: 1600, height: 950 },
  });

  context.on("page", (page) => page.on("response", (r) => void record(r)));
  const page = await context.newPage();
  page.on("response", (r) => void record(r));

  await page.goto(PORTAL_HOME, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });

  console.log("=".repeat(74));
  console.log("이미 로그인된 세션으로 열었습니다. 재로그인은 필요 없습니다.");
  console.log("");
  console.log("  [첨부 업로드]  진행 중 케이스를 열고 답변 칸에서");
  console.log("                 파일 첨부 버튼 -> 작은 파일 하나 선택");
  console.log("                 >>> 전송(Send) 은 절대 누르지 마세요 <<<");
  console.log("                 파일 고른 직후 아래에 요청이 찍히면 두 단계 구조입니다.");
  console.log("                 찍히지 않으면 전송할 때만 올라가는 구조입니다.");
  console.log("");
  console.log("  [첨부 다운로드] 첨부가 달린 케이스에서 기존 파일 하나를 내려받기");
  console.log("");
  console.log("  다 되면 [브라우저 창을 닫으세요]");
  console.log("=".repeat(74));
  console.log("");
  console.log("--- 캡처되는 요청 ---");

  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    if (page.isClosed()) break;
    try {
      await context.storageState({ path: resolve(SESSION_FILE) });
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  save();
  await browser.close().catch(() => undefined);

  console.log("");
  console.log(`캡처 ${captured.length}건 저장 -> ${OUT_DIR}`);
}

main()
  .catch((error: unknown) => {
    console.error("캡처 실패:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
