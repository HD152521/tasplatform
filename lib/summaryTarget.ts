/**
 * Confluence 문서의 "대상 환경" 칸 값.
 *
 * 이 값은 사람이 고른다. 본문만으로는 은행인지 중앙회인지 알 수 없다 —
 * 근거는 lib/summaryPrompt.ts 의 TARGET_PLACEHOLDER 주석에 있다.
 *
 * 화면(클라이언트 컴포넌트)이 불러 쓰므로 프롬프트 본문과 파일을 나눠 둔다.
 * summaryPrompt.ts 는 프롬프트 문자열이 커서 번들에 딸려가면 손해다.
 *
 * 표기는 팀 양식 그대로다(lib/summaryPrompt.ts 의 양식 설명 참고):
 *   [은] · [중] · [은/중] 뒤에 개발 / 운영 / DR / AWS 를 쉼표로 잇는다.
 *   예: [은]운영 · [은/중]개발 · [은/중]개발,운영
 */

/**
 * 아무것도 안 골랐을 때 표에 남는 값.
 *
 * 모델에게 맡기지 않는다. 본문만으로는 은행인지 중앙회인지 알 수 없다 — 실제 문서
 * 3건 중 NACF·NHBank 같은 단서가 표기와 맞아떨어진 것은 1건뿐이었고(NHBank 만
 * 나오는데 [은/중] 인 건이 있었다), 개발·운영을 가리키는 낱말은 3건 모두 본문에
 * 아예 없었다. 계정으로도 못 정한다(같은 사이트의 문서가 [은/중]개발 · [은] 운영
 * 으로 갈렸다). 틀린 값이 조용히 실리는 것보다 빈칸임을 드러내는 편이 낫다.
 */
export const TARGET_PLACEHOLDER = "(입력 필요)";

/** 법인. mark 가 대괄호 안에 들어가는 글자다. */
export const TARGET_CORPS = [
  { id: "bank", label: "은행", mark: "은" },
  { id: "central", label: "중앙회", mark: "중" },
] as const;

export type TargetCorpId = (typeof TARGET_CORPS)[number]["id"];

/** 환경. 양식이 정한 넷이다. */
export const TARGET_ENVS = ["개발", "운영", "DR", "AWS"] as const;

export type TargetEnv = (typeof TARGET_ENVS)[number];

/**
 * 고른 것들을 양식 표기로 만든다.
 *
 * 고른 순서가 아니라 **선언 순서**로 낸다. 같은 조합이면 늘 같은 문자열이 나와야
 * 문서끼리 비교가 된다(은행을 먼저 눌렀든 중앙회를 먼저 눌렀든 `[은/중]`).
 * 아무것도 안 고르면 빈 문자열이고, 그때 표에는 "(입력 필요)" 가 남는다.
 */
export function buildTargetLabel(
  corps: readonly string[],
  envs: readonly string[],
): string {
  const marks = TARGET_CORPS.filter((c) => corps.includes(c.id)).map((c) => c.mark);
  const picked = TARGET_ENVS.filter((e) => envs.includes(e));
  const head = marks.length > 0 ? `[${marks.join("/")}]` : "";
  return `${head}${picked.join(",")}`;
}
