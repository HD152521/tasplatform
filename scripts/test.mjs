/**
 * 테스트 러너 래퍼 — 밀폐(hermetic) 보장.
 *
 * 프로덕션 .env 의 DB 라우팅 값(DATABASE_URL/VCAP_SERVICES/SR_PG_SCHEMA/SR_DB_FILE)이
 * 테스트로 새면, 배포 VM 에서 `npm test` 가 도달 불가한 TAS 내부 Postgres 에 붙으려다
 * 터진다(getaddrinfo ENOTFOUND ...bosh). 테스트는 항상 SQLite 임시 파일만 쓰도록,
 * 여기서 그 값들을 제거한 환경으로 node --test 를 띄운다. 각 테스트가 필요한 값은 직접 설정한다.
 */
import { spawn } from "node:child_process";

const env = { ...process.env };
// 테스트 중 .env 를 읽지 않게 한다(loadEnv 가드). 이게 없으면 config/서버가 로드될 때
// loadEnv 가 .env 를 다시 읽어 DATABASE_URL 을 되살린다.
env.SR_SKIP_DOTENV = "1";
// 혹시 셸에서 export 된 값이 있어도 테스트로 새지 않게 제거(방어).
for (const key of ["SR_DATABASE_URL", "DATABASE_URL", "VCAP_SERVICES", "SR_PG_SCHEMA", "SR_DB_FILE"]) {
  delete env[key];
}

/**
 * `--conditions=react-server` 를 왜 거는가.
 *
 * 이 레포의 서버 전용 모듈은 머리말에 `import "server-only"` 를 둔다. 그 패키지는
 * 평소에 **던지는** 모듈이라, 그걸 import 하는 파일은 `node --test` 에서 아예 못
 * 불러온다(그래서 전에는 테스트할 부분만 따로 떼어 냈다 — lib/requestAudit.ts 머리말).
 *
 * `server-only` 는 `react-server` 조건에서 **빈 모듈**로 해석된다(그 패키지의 exports).
 * 이 레포가 mcp 서버와 login-cli 를 이미 그 조건으로 돌리고 있다(package.json).
 * 테스트에도 같은 조건을 주면 Jira 쓰기 경로처럼 "fetch 를 바꿔 끼워 확인해야 하는"
 * 모듈을 그대로 불러올 수 있다 — 그 경로에 시험이 없던 것이 S5 의 가장 큰 공백이었다.
 */
const child = spawn(
  process.execPath,
  ["--conditions=react-server", "--test", "test/**/*.test.ts"],
  { stdio: "inherit", env },
);
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
