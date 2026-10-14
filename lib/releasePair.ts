/**
 * 제품과 릴리스의 **짝**을 만든다 — 순수 함수.
 *
 * ## 왜 짝이어야 하나
 *
 * 릴리스 번호(`releaseId`)는 제품별 값이 아니라 **버전 문자열에 묶인 전역 값**이다.
 * 실측으로 `10.4.2` 는 GemFire·RabbitMQ·TAS 에서 모두 `798` 이다. 그래서 그 번호만으로는
 * 어느 제품의 릴리스인지 알 수 없고, 분류(`categoryId`)가 그것을 정한다.
 *
 * 둘을 따로 다루면 **조용히 어긋난다.** 지금까지가 바로 그 상태였다 — 등록 payload 에
 * 분류는 TAS 로, 릴리스는 `10.4.2` 로 박혀 있어서, 사람이 어떤 제품을 고르든 그 조합으로
 * 올라갔다. 화면에는 Prod Release 칸이 **필수로 표시되어 있었는데 그 값은 버려졌다.**
 *
 * 그래서 분류를 화면에서 받지 않는다. **제품에서 되찾는다.** 그러면 어긋날 자리가 없다.
 *
 * ## 왜 "못 고르면 그냥 보내기" 가 안 되는가
 *
 * 처음에는 릴리스를 못 고르면 분류·릴리스를 **둘 다 안 보내고** 템플릿 값으로 두려 했다.
 * "지금까지의 동작이니 적어도 포털이 받아 주는 조합" 이라고 생각했는데, **틀렸다.**
 * 등록 payload 의 `subCategoryId`(제품)는 사람이 고른 값으로 **무조건** 덮어써진다.
 * 그러면 "제품은 GemFire, 분류는 TAS, 릴리스는 10.4.2" 처럼 세 값이 서로 다른 제품을
 * 가리키는 요청이 나간다 — 사람이 고른 적 없는 조합이고, 고치려던 바로 그 실패다.
 *
 * 그래서 **못 고르면 등록하지 않는다.** 이유를 구분해 돌려주고, 화면이 사람에게
 * 고르게 한다. 거절은 사람이 한 번 더 누르면 되지만, 틀린 버전으로 올라간 SR 은
 * 답변이 오고 나서야 드러난다.
 */
import { categoryIdOf } from "./productCategory.ts";

export type ReleaseResolution =
  | { readonly ok: true; readonly categoryId: number; readonly releaseId: number }
  | { readonly ok: false; readonly code: "unknown_product" | "no_release"; readonly message: string };

/**
 * 고른 제품과 릴리스로 짝을 만든다. 못 만들면 **이유를 구분해서** 돌려준다.
 *
 * `releaseId` 는 화면에서 사람이 목록에서 고른 값이다. 글자로 적은 버전 이름이 아니라
 * 번호여야 한다 — 이름으로 보내면 포털이 거절하거나, 더 나쁘게는 엉뚱한 것으로 받는다.
 */
export function resolveRelease(productId: unknown, releaseId: unknown): ReleaseResolution {
  const product = Number(productId);
  const release = Number(releaseId);

  if (!Number.isInteger(product) || product <= 0) {
    return { ok: false, code: "unknown_product", message: "제품을 고르세요." };
  }

  // 분류 표에 없는 제품은 이 경로로 등록할 수 없다(lib/productCategory.ts).
  // 릴리스를 못 고르는 것이 아니라 등록 자체가 거절되는 제품이다.
  const categoryId = categoryIdOf(product);
  if (categoryId === null) {
    return {
      ok: false,
      code: "unknown_product",
      message: "이 제품은 지금 이 도구로 등록할 수 없습니다. 포털에서 직접 올려주세요.",
    };
  }

  if (!Number.isInteger(release) || release <= 0) {
    return {
      ok: false,
      code: "no_release",
      message: "Prod Release 를 목록에서 골라야 등록됩니다.",
    };
  }

  return { ok: true, categoryId, releaseId: release };
}
