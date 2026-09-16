/**
 * 배포 스모크 스크립트 (ESM, 브라우저 불필요).
 *
 * 배포된 인스턴스의 base URL 을 받아(환경변수 BASE_URL 또는 첫 argv, 기본 http://127.0.0.1:3000)
 * 핵심 경로를 순차로 점검한다. TAS 컨테이너엔 브라우저가 없으므로 API/서버렌더 경로만 GET 한다.
 *
 * 종료코드: 필수 항목이 하나라도 실패하면 비영점(1). deploy/CI 가 이걸로 성패를 감지한다.
 * 판정 로직은 아래 checkResult 순수 함수로 뽑아 테스트한다(fetch/네트워크는 main 이 담당).
 *
 * 보안: 토큰·자격은 다루지도 출력하지도 않는다. base URL 만 출력한다(자격 없음).
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
const TIMEOUT_MS = 10_000;

/**
 * 점검 항목. json=true 면 응답 본문의 ok 필드까지 본다. optional=true 면 실패해도 종료코드에
 * 영향을 주지 않는다(배포에 따라 없을 수 있는 경로).
 * @type {ReadonlyArray<{ path: string, json: boolean, optional?: boolean }>}
 */
const CHECKS = [
  { path: "/api/health", json: true },
  { path: "/", json: false },
  { path: "/closed", json: false },
  { path: "/settings", json: false },
  { path: "/logs", json: false },
  { path: "/api/settings?team=default", json: true },
  { path: "/settings/llm", json: false, optional: true },
];

/**
 * 한 점검 항목의 판정(순수). 네트워크·fetch 없음.
 *
 * @param {string} path 점검한 경로
 * @param {number} status 응답 상태코드(네트워크 오류/타임아웃이면 0 을 넘긴다)
 * @param {boolean | null} [jsonOk] JSON 항목이면 본문 ok 값(true/false), 아니면 null
 * @returns {{ path: string, ok: boolean, detail: string }}
 */
export function checkResult(path, status, jsonOk = null) {
  if (status === 0) return { path, ok: false, detail: "network_error" };
  if (status !== 200) return { path, ok: false, detail: `status ${status}` };
  if (jsonOk === false) return { path, ok: false, detail: "json ok:false" };
  return { path, ok: true, detail: jsonOk === true ? "200 ok:true" : "200" };
}

/**
 * 한 항목을 실제로 GET 해 판정한다. 타임아웃·네트워크 오류는 status 0 으로 환원해 실패 처리한다.
 * @param {string} baseUrl
 * @param {{ path: string, json: boolean, optional?: boolean }} check
 */
async function probe(baseUrl, check) {
  const url = baseUrl.replace(/\/+$/, "") + check.path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    let jsonOk = null;
    if (check.json) {
      try {
        const body = await res.json();
        jsonOk = body != null && body.ok === true;
      } catch {
        jsonOk = false; // JSON 을 기대했는데 파싱 실패 → 실패로 본다
      }
    }
    return checkResult(check.path, res.status, jsonOk);
  } catch {
    // 타임아웃(abort)·연결 거부·DNS 실패 모두 여기로 온다.
    return checkResult(check.path, 0);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const baseUrl = (process.env.BASE_URL || process.argv[2] || DEFAULT_BASE_URL).trim();
  console.log(`스모크 점검 대상: ${baseUrl}`);
  console.log("");

  const failures = [];
  for (const check of CHECKS) {
    const result = await probe(baseUrl, check);
    const mark = result.ok ? "✔" : check.optional ? "○" : "✖";
    console.log(`${mark} ${result.path} — ${result.detail}`);
    if (!result.ok && !check.optional) failures.push(result.path);
  }

  console.log("");
  console.log(
    "재시작 유지 확인: `cf restart broadcom-sr-web` 후 이 스크립트를 다시 돌려 " +
      "/api/health 의 teams 수와 / 목록이 그대로인지 확인하세요.",
  );

  if (failures.length > 0) {
    console.log("");
    console.log(`실패 ${failures.length}건: ${failures.join(", ")}`);
    return 1;
  }
  return 0;
}

// 진입점으로 직접 실행될 때만 main 을 돈다. 테스트가 checkResult 를 import 할 때는
// 네트워크/exit 부작용이 없어야 하므로 가드한다(scripts/seed-session.ts 와 동일한 패턴).
const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error("스모크 실행 실패:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
