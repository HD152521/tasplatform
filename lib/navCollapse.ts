/**
 * 사이드바 접힘 목록을 확정하는 한 곳.
 *
 * `lib/navActive.ts` 와 같은 이유로 lib 에 둔다 — 시험이 `.tsx` 를 읽지 못하고,
 * 이 판정이 틀리면 **모든 화면**이 날아가므로 반드시 시험으로 잠가야 한다.
 */

/**
 * localStorage 에서 읽은 것을 **이름 목록으로 확정한다.**
 *
 * `JSON.parse(raw) as string[]` 로 두면 `as` 가 거짓말을 한다 — 저장된 것이 배열이
 * 아니면(옛 모양·다른 탭이 덮어쓴 값·손으로 고친 값) `collapsed.includes(...)` 가
 * 터진다. 그리고 그 터짐은 **사이드바에서** 일어나므로 화면 하나가 아니라 **모든
 * 화면**이 "Application error" 가 되고, 지워질 때까지 그 브라우저에서 계속 그렇다.
 * 그 사람에게만 보이는 고장이라 "내 것만 안 된다" 가 된다.
 *
 * 그래서 아는 모양(문자열 배열)만 받고 나머지는 **빈 목록**으로 떨어진다 — 접힘은
 * 편의일 뿐이라, 잘못된 값 하나로 도구를 못 쓰게 만들 이유가 없다.
 */
export function collapsedNames(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}
