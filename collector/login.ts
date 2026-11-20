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

import { DEFAULT_TEAM_ID, NAV_TIMEOUT_MS, PORTAL_HOME } from "../lib/config.ts";
import { deviceTrustAvailable, loginContextOptions } from "../lib/browserIdentity.ts";
import { launchBrowser } from "./session.ts";
import {
  CredentialsMissingError, OtpRequiredError,
  performCredentialLogin, saveSession,
} from "./autoLogin.ts";
import { openDb, type Db } from "../lib/db.ts";
import { getPortalCredentials } from "../lib/portalCredentials.ts";
import {
  assertAutoLoginAllowed, clearLoginGuard, readLoginGuard, recordLoginAttempt,
} from "../lib/loginGuard.ts";
import { outcomeOf } from "../lib/loginOutcome.ts";

const AUTO = process.argv.includes("--auto");
const POLL_MS = 3000;
const MAX_WAIT_MS = 60 * 60 * 1000;
async function main(): Promise<void> {
  // 자격과 잠금 방지 상태는 DB 에 있다(설정 화면에서 바꾼 값이 여기로 온다).
  const db = await openDb();
  try {
    await run(db);
  } finally {
    await db.close();
  }
}

async function run(db: Db): Promise<void> {
  const credentials = await getPortalCredentials(db);
  const guard = await readLoginGuard(db);

  // --auto 는 무인 경로다. 차단 중이면 여기서 끝낸다(비밀번호를 또 보내지 않는다).
  if (AUTO) await assertAutoLoginAllowed(db);

  // 창을 띄우는 경로에서 차단 중이면 **저장된 비밀번호로는 시도하지 않는다.** 이미 두 번
  // 거절된 값을 또 보내면 잠금만 가까워진다. 사람이 직접 치도록 바로 넘긴다.
  const autoAllowed = credentials !== null && !guard.blocked;
  if (credentials !== null && guard.blocked) {
    console.log(
      `저장된 계정은 자동 시도가 멈춰 있습니다 — ${guard.lastReason || "거절"}.`,
    );
    console.log("저장된 비밀번호로는 시도하지 않습니다. 브라우저에서 직접 로그인하세요.");
  }

  const browser = await launchBrowser(!AUTO ? false : true);
  // 기기 신뢰 쿠키를 넘겨야 IdP 가 같은 기기로 보고 OTP 를 생략한다.
  const context = await browser.newContext(loginContextOptions(browser));
  if (deviceTrustAvailable()) console.log("기기 신뢰 쿠키를 사용합니다 (OTP 생략 기대).");
  const page = await context.newPage();

  try {
    if (autoAllowed && credentials !== null) {
      const where = credentials.source === "db" ? "설정 화면" : ".env";
      console.log(`저장된 계정으로 로그인 시도: ${credentials.username} (${where})`);
      try {
        await performCredentialLogin(page, credentials);
      } catch (error) {
        await record(db, error);
        throw error;
      }
      const path = await saveSession(context);
      await recordLoginAttempt(db, { outcome: "ok", reason: "", passwordSubmitted: true });
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

  // 사람이 직접 로그인해 세션이 생겼다. 잠금 방지 카운터를 푼다.
  // 다만 **저장된 비밀번호는 그대로**다 — 그걸 안 바꾸면 다음 무인 회차가 또 거절당한다.
  // 그 한 줄을 반드시 말해 준다. 이게 "고친 줄 알았는데 또 잠겼다" 를 막는다.
  if (savedPath !== "") {
    await clearLoginGuard(db, DEFAULT_TEAM_ID, "사람이 직접 로그인");
    const stored = await getPortalCredentials(db);
    if (stored !== null) {
      const where = stored.source === "db" ? "설정 화면" : ".env";
      console.log(
        `주의: 저장된 비밀번호(${where})는 그대로입니다.` +
          " 비밀번호를 바꾸셨다면 /settings/account 에서 새 값도 저장하세요.",
      );
    }
  }
}

/** 실패 사유를 잠금 방지 카운터에 넣는다. 기록이 깨져도 로그인 보고를 가리지 않는다. */
async function record(db: Db, error: unknown): Promise<void> {
  try {
    const state = await recordLoginAttempt(db, outcomeOf(error));
    if (state.blocked) {
      console.error(
        "자동 로그인을 멈췄습니다(계정 잠금 방지). 스스로 다시 시도하지 않습니다 —" +
          " 설정 화면에 새 비밀번호를 저장하거나 여기서 직접 로그인하세요.",
      );
    }
  } catch (recordError) {
    console.error(
      "[login] 잠금 방지 기록 실패:",
      recordError instanceof Error ? recordError.message : String(recordError),
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error("로그인 실패:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
