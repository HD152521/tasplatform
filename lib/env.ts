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
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      // 줄 끝 주석을 걷어낸다. CONFLUENCE_PARENT_ID 가 `172097555  # "04. SR" 페이지`
      // 로 적혀 있어 주석까지 값에 들어갔고, Confluence API 가 404 를 냈다.
      //
      // 공백 뒤의 # 만 주석으로 본다. 비밀번호에 # 이 들어가는 일이 있어서
      // (예: `PW=ab#cd`) 붙어 있는 # 은 값의 일부로 남긴다. 값이 # 으로 시작하는
      // 경우처럼 애매하면 따옴표로 감싸면 된다 — 위 quoted 분기가 통째로 살린다.
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment).trim();
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
