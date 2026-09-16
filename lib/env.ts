/**
 * .env 를 읽어 process.env 에 채운다.
 * dotenv 를 쓰지 않는 이유: 의존성 하나를 줄이고, 파싱 규칙을 눈에 보이게 두기 위해서다.
 * 이미 설정된 환경변수는 덮어쓰지 않는다.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadEnv(file = ".env"): void {
  // 테스트(SR_SKIP_DOTENV)에서는 기본 .env 를 읽지 않는다 — 프로덕션 .env 의 DATABASE_URL
  // 등이 테스트로 새어 도달 불가한 실제 DB 에 붙으려다 터지는 것을 막는다. 명시적 파일을
  // 넘긴 호출(env.test.ts 등)은 그대로 동작한다.
  if (file === ".env" && process.env.SR_SKIP_DOTENV) return;
  const path = resolve(file);
  if (!existsSync(path)) return;

  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
