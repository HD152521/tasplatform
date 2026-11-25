/**
 * 지금 돌고 있는 것이 어느 커밋인가.
 *
 * ## 왜 필요한가
 *
 * "고쳤는데 아직도 안 된다" 를 한 시간 동안 못 가렸다. 코드에는 고친 것이 들어 있고
 * 화면은 여전히 깨져 있었는데, **배포가 돌지 않아 옛 빌드가 떠 있던 것**이다. 그걸
 * 알아낸 방법은 "새로 만든 페이지(/notes)가 404 인지" 를 찔러 본 것이었다 — 새 화면이
 * 없는 변경이면 그 방법도 통하지 않는다.
 *
 * 그래서 돌고 있는 빌드가 **스스로 커밋을 말하게** 한다. `curl /api/health` 한 줄로
 * "배포됐나" 가 끝난다.
 *
 * ## 왜 환경변수가 아니라 파일인가
 *
 * `cf push` 는 manifest 의 env 만 덮어쓰고 `cf set-env` 로 넣은 것을 보존한다. 커밋은
 * push 마다 바뀌는 값이라 manifest 에 적을 수 없고, CI 가 매번 `cf set-env` + 재시작을
 * 하게 하면 배포가 한 단계 늘고 재시작이 한 번 더 돈다. 빌드할 때 파일 한 줄을 쓰면
 * 그 파일이 드롭릿에 함께 올라간다(.cfignore 가 빼지 않는다).
 *
 * 파일이 없으면 `"unknown"` 이다 — 로컬 실행과 옛 빌드가 그렇다. **없는 것을 그럴듯한
 * 값으로 메우지 않는다.** "unknown" 이 보이면 그 자체로 "CI 를 안 거친 빌드" 라는 뜻이다.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface BuildVersion {
  /** 커밋 해시(짧은 것). 모르면 "unknown". */
  readonly commit: string;
  /** 빌드한 시각(ISO). 모르면 빈 문자열. */
  readonly builtAt: string;
}

export const UNKNOWN_VERSION: BuildVersion = { commit: "unknown", builtAt: "" };

/** CI 가 쓰는 파일 이름. 레포 루트에 둔다(앱 루트 = 레포 루트). */
export const VERSION_FILE = ".version";

/**
 * `.version` 한 줄을 뜯는다. 모양은 `<커밋> <ISO시각>` 이고 둘째 칸은 없어도 된다.
 *
 * 순수 함수다 — 파일 읽기는 아래 `readBuildVersion` 이 한다. 모양이 조금 틀어져도
 * (빈 줄·칸 하나·줄바꿈이 섞임) 터지지 않고 아는 만큼만 돌려준다. 이 값은 진단에
 * 쓰는 것이라, 읽다 실패해서 헬스체크를 500 으로 만들면 **고치려던 문제를 키운다.**
 */
export function parseVersion(raw: string): BuildVersion {
  const line = raw.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  if (line === "") return UNKNOWN_VERSION;
  const [commit = "", builtAt = ""] = line.split(/\s+/);
  if (commit === "") return UNKNOWN_VERSION;
  return { commit, builtAt };
}

/** 프로세스당 한 번만 읽는다. 배포 중에 바뀌지 않는 값이다. */
let cached: BuildVersion | null = null;

export function readBuildVersion(): BuildVersion {
  if (cached !== null) return cached;
  try {
    cached = parseVersion(readFileSync(join(process.cwd(), VERSION_FILE), "utf8"));
  } catch {
    // 파일이 없는 것은 고장이 아니다 — 로컬 실행이 그렇다.
    cached = UNKNOWN_VERSION;
  }
  return cached;
}
