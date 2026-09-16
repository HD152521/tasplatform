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
for (const key of ["DATABASE_URL", "VCAP_SERVICES", "SR_PG_SCHEMA", "SR_DB_FILE"]) {
  delete env[key];
}

const child = spawn(process.execPath, ["--test", "test/**/*.test.ts"], { stdio: "inherit", env });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
