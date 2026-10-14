/**
 * 적은 글에서 Prod Release 를 **찾아만** 본다.
 *
 * 간단히 올리기는 한국어 한 덩어리를 받아 등록할 값을 전부 정해 주는 자리다. 버전도
 * 글에 적혀 있기 마련이라("TPCF 10.4.2 에서…") 그걸 집어 주면 사람이 한 번 덜 고른다.
 *
 * ## 애매하면 **비운다**
 *
 * 비슷한 것을 골라 주지 않는다. 틀린 버전으로 SR 이 올라가면 담당 엔지니어가 엉뚱한
 * 환경을 들여다보고, 그 사실은 답변이 오고 나서야 드러난다. 버전이 비어 있는 것은
 * 사람이 화면에서 고르면 되는 일이고, 틀린 버전은 되돌릴 수 없다.
 *
 * 그래서 `matchRelease` 의 **정확히 일치**만 받는다(lib/releaseList.ts). `10.4` 라고
 * 적혀 있고 목록에 `10.4.2`·`10.4.3` 만 있으면 아무것도 고르지 않는다 — 둘 중 하나를
 * 찍는 것은 추측이다.
 *
 * ## 못 찾는 것은 고장이 아니다
 *
 * 세션이 없거나 포털이 느려도 **던지지 않는다.** 버전을 못 집는 것 때문에 "간단히
 * 올리기" 전체가 실패하면, 7~8초 걸려 만든 초안까지 버리게 된다.
 */
import { categoryIdOf } from "./productCategory.ts";
import {
  findReleases,
  matchRelease,
  versionCandidates,
  type Release,
  type ReleaseLookupClient,
} from "./releaseList.ts";

/**
 * 몇 개까지 물어볼지.
 *
 * 글에 숫자가 여럿 있으면(`10.4.2`, `4.1.3`, `2.7`) 긴 것부터 본다. 다 물어보면 포털
 * 왕복이 그만큼 쌓이는데, 이 자리는 사람이 앞에서 기다리는 구간이다.
 */
const MAX_TRIES = 3;

/** 글에서 찾은 릴리스. 못 찾으면 null. */
export async function guessRelease(
  client: ReleaseLookupClient,
  productId: number,
  text: string,
): Promise<Release | null> {
  const categoryId = categoryIdOf(productId);
  if (categoryId === null) return null;

  for (const candidate of versionCandidates(text).slice(0, MAX_TRIES)) {
    let list: Release[];
    try {
      list = await findReleases(client, categoryId, candidate);
    } catch {
      // 세션 만료·망 오류. 버전을 못 집는 것일 뿐이다.
      return null;
    }
    // 목록을 그 후보 글자로 다시 좁힌다 — `matchRelease` 가 정확히 일치만 받는다.
    const hit = matchRelease(list, candidate);
    if (hit !== null) return hit;
  }
  return null;
}
