/**
 * SR 심각도 — 보이는 이름과 포털이 쓰는 id.
 *
 * 작성 폼(app/new/DraftForm.tsx)과 간단히 올리기(app/new/QuickModal.tsx)가 **같은 표**를
 * 써야 한다. 한때 둘이 각자 베껴 두고 있었는데, 한쪽만 고치면 같은 심각도를 골랐는데
 * 다른 우선순위로 등록되고 **그걸 포털에서 보기 전까지 모른다.**
 *
 * id 는 실측값이다(포털의 request_type_priority_mapping). 지어낸 값을 넣으면 등록이
 * 거절되거나 엉뚱한 우선순위로 들어간다.
 *
 * 의존성을 두지 않는다 — 클라이언트 컴포넌트가 직접 가져다 쓴다.
 */

export const SEVERITIES = [
  "Critical - P1",
  "High - P2",
  "Medium - P3",
  "Low - P4",
] as const;

export type Severity = (typeof SEVERITIES)[number];

const PRIORITY_ID: Record<Severity, number> = {
  "Critical - P1": 1,
  "High - P2": 2,
  "Medium - P3": 3,
  "Low - P4": 4,
};

/** 기본값. 포털 폼의 기본과 같은 P3 다. */
export const DEFAULT_SEVERITY: Severity = "Medium - P3";

/**
 * 보이는 이름 → 포털 우선순위 id.
 *
 * 모르는 이름이면 **P3** 으로 둔다. 등록을 막는 것보다 보통 우선순위로 올리는 편이
 * 낫다 — 심각도를 못 읽었다고 SR 을 못 올리면 그게 더 급한 일이 된다.
 */
export function priorityIdOf(severity: string): number {
  return PRIORITY_ID[severity as Severity] ?? PRIORITY_ID[DEFAULT_SEVERITY];
}
