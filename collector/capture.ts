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

interface Captured {
  index: number;
  method: string;
  url: string;
  status: number;
  postData: string | null;
  response: string;
}

const captured: Captured[] = [];

async function record(response: Response): Promise<void> {
  const url = response.url();
  if (SKIP.test(url)) return;
  if (!url.includes("wolkenservicedesk.com")) return;

  const type = (response.headers()["content-type"] ?? "").toLowerCase();
  if (!type.includes("json")) return;

  let body = "";
  try {
    body = await response.text();
  } catch {
    return;
  }
  if (body.length < 2) return;

  const request: Request = response.request();
  const index = captured.length + 1;
  captured.push({
    index,
    method: request.method(),
    url,
    status: response.status(),
    postData: request.postData(),
    response: body.slice(0, 300_000),
  });

  const short = url.replace("https://api-broadcomcms-software.wolkenservicedesk.com", "");
  console.log(
    `  [${String(index).padStart(3, "0")}] ${request.method().padEnd(5)} ${response.status()} ` +
      `${String(body.length).padStart(8)}B  ${short.slice(0, 96)}`,
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
  console.log("  1) 케이스 목록 화면으로 이동");
  console.log("  2) 종료(Closed) 케이스를 보는 필터나 탭을 여세요");
  console.log("  3) 종료 케이스 목록이 실제로 화면에 뜬 것을 확인");
  console.log("  4) 가능하면 종료 케이스 하나를 열어보세요");
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
