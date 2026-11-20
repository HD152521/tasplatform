/**
 * 헤드리스 서버(VM)용 CLI 로그인.
 *
 * GUI 창을 띄우는 `npm run login` 과 달리, 브라우저는 헤드리스로 돌리고 OTP 만 터미널로
 * 입력받는다. 화면 없는 리눅스 서버(예: VCF VM)에서 최초 1회 이걸로 로그인해 기기신뢰
 * (_iat1)를 이 머신에 확립하면, 이후엔 수집기가 무인으로 자동 재로그인한다(OTP 불필요,
 * 2027년까지).
 *
 *   node scripts/login-cli.ts        (npm run login:cli)
 *
 * 계정은 설정 화면에 저장한 값(DB)을 먼저 쓰고, 없으면 .env 의 SR_USERNAME /
 * SR_PASSWORD 를 쓴다. 성공하면 data/session.json·device.json 저장.
 * ⚠ 이 머신은 브라우저를 띄워야 하므로 SR_DISABLE_BROWSER_LOGIN 을 설정하지 말 것.
 */
import { loadEnv } from "../lib/env.ts";
loadEnv();

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { openDb } from "../lib/db.ts";
import { getPortalCredentials } from "../lib/portalCredentials.ts";
import { readLoginGuard } from "../lib/loginGuard.ts";
import { startLogin, submitOtp, type LoginResult } from "../lib/loginFlow.ts";

const MAX_OTP_ATTEMPTS = 3;

async function main(): Promise<number> {
  const db = await openDb();
  let credentials;
  let guard;
  try {
    credentials = await getPortalCredentials(db);
    guard = await readLoginGuard(db);
  } finally {
    await db.close();
  }

  if (credentials === null) {
    console.error(
      "저장된 계정이 없습니다. 설정 화면(/settings/account)에서 저장하거나" +
        " .env 에 SR_USERNAME / SR_PASSWORD 를 넣으세요.",
    );
    return 1;
  }

  // 사람이 직접 실행한 명령이라 막지는 않는다. 다만 저장된 비밀번호가 이미 거절당한
  // 상태라면 그 사실을 먼저 알린다 — 모르고 돌리면 잠금에 한 걸음 더 가까워진다.
  if (guard !== undefined && guard.blocked) {
    console.error(
      `⚠ 이 비밀번호는 이미 거절됐습니다(${guard.lastReason || "사유 미기록"}).` +
        " 자동 시도는 멈춘 상태입니다.",
    );
    console.error("  비밀번호가 바뀌었다면 먼저 /settings/account 에 새 값을 저장하세요.");
  }

  console.log(`로그인 시도: ${credentials.username} (헤드리스)`);
  let result: LoginResult = await startLogin(credentials.username, credentials.password);

  if (result.status === "otp_required") {
    const { flowId } = result;
    const hint = result.hint ? ` (${result.hint})` : "";
    console.log("기기신뢰가 없어 OTP 가 필요합니다. 이메일로 온 코드를 입력하세요.");
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      for (let attempt = 0; attempt < MAX_OTP_ATTEMPTS; attempt += 1) {
        const code = (await rl.question(`OTP 코드${hint}: `)).trim();
        if (code === "") continue;
        result = await submitOtp(flowId, code);
        if (result.status === "done") break;
        console.error(`  → ${result.status === "error" ? result.message : result.status}`);
      }
    } finally {
      rl.close();
    }
  }

  if (result.status === "done") {
    console.log("✅ 로그인 성공 — data/session.json·device.json 저장됨.");
    console.log("   이 머신에 기기신뢰가 생겼습니다. 이후 수집기가 무인 자동 재로그인합니다.");
    return 0;
  }
  console.error(`❌ 로그인 실패: ${result.status === "error" ? result.message : result.status}`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error("로그인 오류:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
