/**
 * 로그인.
 *
 *   npm run login          브라우저를 띄운다. 계정이 설정돼 있으면 자동 입력하고,
 *                          OTP를 요구받으면 사람이 직접 입력한다.
 *   npm run login -- --auto  창 없이 자동 로그인만 시도한다.
 *                          OTP가 필요하면 우회하지 않고 실패한다.
 */
import { loadEnv } from "../lib/env.ts";
loadEnv();

import { CREDENTIALS, NAV_TIMEOUT_MS, PORTAL_HOME } from "../lib/config.ts";
import { launchBrowser } from "./session.ts";
import {
  CredentialsMissingError, OtpRequiredError,
  performCredentialLogin, saveSession,
} from "./autoLogin.ts";

const AUTO = process.argv.includes("--auto");
const POLL_MS = 3000;
const MAX_WAIT_MS = 60 * 60 * 1000;
const VIEWPORT = { width: 1600, height: 950 } as const;

async function main(): Promise<void> {
  const browser = await launchBrowser(!AUTO ? false : true);
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();

  try {
    if (CREDENTIALS !== null) {
      console.log(`저장된 계정으로 로그인 시도: ${CREDENTIALS.username}`);
      await performCredentialLogin(page);
      const path = await saveSession(context);
      console.log(`자동 로그인 성공. 세션 저장 -> ${path}`);
      return;
    }

    if (AUTO) throw new CredentialsMissingError();
    await page.goto(PORTAL_HOME, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  } catch (error) {
    if (AUTO) throw error;

    if (error instanceof OtpRequiredError) {
      console.log("");
      console.log("OTP 인증이 필요합니다. 브라우저에서 직접 입력해 주세요.");
    } else if (error instanceof CredentialsMissingError) {
      console.log("저장된 계정이 없습니다. 브라우저에서 직접 로그인하세요.");
    } else {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`자동 로그인 실패: ${message}`);
      console.log("브라우저에서 직접 로그인해 주세요.");
    }
  }

  // 수동 개입 경로: 사람이 로그인하고 창을 닫으면 세션을 저장한다.
  console.log("=".repeat(72));
  console.log("브라우저에서 로그인을 완료한 뒤 [창을 닫으세요].");
  console.log("창을 닫으면 세션이 저장되고 종료됩니다.");
  console.log("=".repeat(72));

  const deadline = Date.now() + MAX_WAIT_MS;
  let savedPath = "";
  while (Date.now() < deadline) {
    if (page.isClosed()) break;
    try {
      savedPath = await saveSession(context);
    } catch {
      break; // 컨텍스트가 닫힘 -> 직전 저장분이 최종본
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  await browser.close().catch(() => undefined);
  console.log(`\n세션 저장 완료 -> ${savedPath}`);
}

main()
  .catch((error: unknown) => {
    console.error("로그인 실패:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
