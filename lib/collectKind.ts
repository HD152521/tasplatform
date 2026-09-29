/**
 * "무엇을 수집하는가" 의 이름표.
 *
 * 수집은 셋이다 — 케이스(Broadcom 포털), 보안 공지(NVD), 기술 문서(Broadcom KB).
 * 서로 다른 수집기가 돌고, 요청 번호도 각자 따로 센다(lib/collectRequest.ts).
 * 여기가 그 셋의 유일한 목록이다.
 *
 * DB 를 만지지 않는 순수 모듈로 따로 뒀다. 이름표는 화면(클라이언트 컴포넌트)도 써야
 * 하는데, collectRequest.ts 를 import 하면 브라우저 번들이 DB 코드를 끌고 온다.
 */

export const COLLECT_KINDS = ["cases", "cves", "kb"] as const;

export type CollectKind = (typeof COLLECT_KINDS)[number];

/** 기본값. 종류를 말하지 않은 호출은 케이스 수집이다 — 이 기능이 먼저 있었다. */
export const DEFAULT_COLLECT_KIND: CollectKind = "cases";

/**
 * 요청에 실려 온 종류 이름을 읽는다.
 *
 * 비었으면 케이스다. **이미 배포된 화면은 종류를 보내지 않는다** — 그 호출이 그대로
 * 돌아야 하므로 없음을 오류로 보지 않는다.
 *
 * 반대로 모르는 이름은 null 로 돌려 부르는 쪽이 거절하게 한다. 조용히 케이스로
 * 떨어뜨리면 오타 하나로 "CVE 를 눌렀는데 케이스 수집이 도는" 일이 생기고, 그건
 * 화면에 아무 표시도 남지 않아 아무도 모른다.
 */
export function parseCollectKind(raw: string | null | undefined): CollectKind | null {
  const value = (raw ?? "").trim();
  if (value === "") return DEFAULT_COLLECT_KIND;
  return COLLECT_KINDS.find((kind) => kind === value) ?? null;
}
