/**
 * 좌측 메뉴에서 **지금 어느 항목에 있나**.
 *
 * ## 왜 따로 떼어 두나
 *
 * 전에는 화면에서 `path.startsWith(item.href)` 로 판단했다. 그러면 `/settings/llm`
 * 에서 `/settings` 도 걸려 **두 항목이 같이 켜져 보였다** — 지금 어디에 있는지 알 수
 * 없다. 메뉴 항목이 늘어날 때마다 같은 일이 생길 수 있어, 규칙을 떼어 시험으로 잠근다.
 *
 * ## 규칙
 *
 * 맞는 것 중 **가장 깊은(긴) 것 하나**만 켠다.
 *   - `/` 는 정확히 일치할 때만 (안 그러면 모든 경로가 걸린다)
 *   - 그 외는 정확히 일치하거나 `/` 로 이어지는 하위 경로일 때
 *
 * 맞는 것이 없으면 `null` 이다. 메뉴에 없는 화면(케이스 상세 `/cases/123` 등)에서는
 * 아무 항목도 켜지 않는다 — 엉뚱한 곳이 켜져 있는 것보다 낫다.
 */
export function activeNavHref(path: string, hrefs: readonly string[]): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    const hit = href === "/"
      ? path === "/"
      : path === href || path.startsWith(`${href}/`);
    if (!hit) continue;
    if (best === null || href.length > best.length) best = href;
  }
  return best;
}
