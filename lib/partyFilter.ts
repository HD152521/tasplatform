/**
 * 파티(고객사) 필터.
 *
 * 하나의 계정이 여러 고객사 SR 을 함께 볼 수 있어, 우리 담당 고객사(사이트)의
 * 케이스만 남긴다. 판정은 partySiteNumber 로 한다 — partyName 문자열은 표기가
 * 바뀔 수 있지만 사이트 번호는 안정적이다.
 */
import type { SearchResultItem } from "./types.ts";

/**
 * allowedSites 에 속한 사이트의 케이스만 남긴다.
 * allowedSites 가 비어 있으면(필터 미설정) 전부 통과시킨다(기존 동작 보존).
 */
export function filterAllowedParties(
  items: readonly SearchResultItem[],
  allowedSites: readonly string[],
): SearchResultItem[] {
  if (allowedSites.length === 0) return [...items];
  const allow = new Set(allowedSites.map((s) => s.trim()));
  return items.filter((item) => allow.has(String(item.partySiteNumber ?? "").trim()));
}
