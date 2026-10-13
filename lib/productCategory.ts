/**
 * Product → categoryId.
 *
 * ## 왜 필요한가 — 지금 모순된 조합이 나가고 있다
 *
 * 등록 payload 에는 제품을 가리키는 값이 **둘** 들어간다.
 *
 *   requestMasterVO.subCategoryId   고른 제품            (사람·분류기가 정한다)
 *   requestMasterVO.categoryId      그 제품이 속한 분류   (템플릿 값 3561 고정이었다)
 *
 * 3561 은 TAS 의 categoryId 다. 그래서 GemFire(4332)를 고르면
 * **subCategoryId=4332 + categoryId=3561** 이라는 서로 안 맞는 조합이 나갔다.
 * 거절되거나, 더 나쁘게는 엉뚱한 분류로 등록된다.
 *
 * `releaseId` 도 같은 이유로 틀렸다 — 템플릿의 798 은 **GemFire 10.4.2** 인데 TAS
 * 케이스에 그대로 실려 나갔다(lib/releaseList.ts 머리말).
 *
 * ## 값의 출처
 *
 * 포털의 `getSubCategoryDetailsForEndUser` 응답을 그대로 옮겼다(2026-10-13 캡처).
 * 우리 계정이 고를 수 있는 제품 25개 전부다. **지어낸 값이 없다** — 틀리면 엉뚱한
 * 분류로 등록되므로, 새 제품을 더할 때는 반드시 그 응답에서 확인할 것.
 *
 * 건수는 제품마다 다르지만 이 표 자체는 거의 바뀌지 않아 박아 둔다. release 목록은
 * 제품당 수천 건이라 그렇게 할 수 없어 그때그때 조회한다(lib/releaseList.ts).
 */

/** productId(subCategoryId) → categoryId */
const CATEGORY_OF: Record<number, number> = {
  4301: 3540,   // Operations Manager
  4787: 4026,   // VCF Automation
  4789: 4028,   // VCF Operations
  4371: 3610,   // VCF Operations for Networks
  4616: 3855,   // VCF Private AI Services
  4389: 3628,   // VMware Cloud Director
  4784: 4023,   // VMware Data Services Manager for VCF Private AI Services
  4368: 3607,   // VMware HCX
  4380: 3619,   // VMware NSX
  4393: 3632,   // VMware SDDC Manager / VCF Installer
  4788: 4027,   // VMware Salt
  4322: 3561,   // VMware Tanzu Application Service
  4645: 3884,   // VMware Tanzu Data Services
  4289: 3528,   // VMware Tanzu Data Suite
  4332: 3571,   // VMware Tanzu Gemfire
  4547: 3786,   // VMware Tanzu Kubernetes Grid Integrated Edition
  4801: 4040,   // VMware Tanzu Platform - Cloud Foundry
  4800: 4039,   // VMware Tanzu Platform - Kubernetes
  4799: 4038,   // VMware Tanzu Platform - SaaS Components
  4333: 3572,   // VMware Tanzu RabbitMQ
  4320: 3559,   // VMware Tanzu Spring Runtime
  4388: 3627,   // VMware vCenter Server
  4339: 3578,   // VMware vSAN
  4281: 3520,   // VMware vSphere ESXi
  4342: 3581,   // VMware vSphere Kubernetes Service
};

/**
 * 그 제품의 categoryId. 모르는 제품이면 **null**.
 *
 * null 일 때 템플릿 값으로 메우지 않는다 — 그게 지금 모순을 만든 원인이다. 부르는 쪽이
 * "이 제품은 모른다" 고 알리고 멈추는 편이, 엉뚱한 분류로 등록하는 것보다 낫다.
 */
export function categoryIdOf(productId: number): number | null {
  return CATEGORY_OF[productId] ?? null;
}

/** 아는 제품인가. */
export function knownProductIds(): number[] {
  return Object.keys(CATEGORY_OF).map(Number);
}

/**
 * 올릴 수 있는 제품만 남긴다.
 *
 * ## 왜 거르나
 *
 * 선택지는 **과거 케이스에서도** 모은다(lib/productCatalog.ts 의 mergeCatalog). 그래서
 * 포털이 더 이상 제공하지 않는 제품이 섞인다 — 실측으로 여섯 개였다.
 *
 *     VMware Tanzu Platform / VMware Tanzu Application Service for VMs
 *     VMware Tanzu Application Platform
 *     Support Portal / Support Portal & Access Issues
 *     Product Entitlements/Contracts Related
 *
 * 앞 세 개는 이름이 바뀌거나 단종된 제품이고, 뒤 세 개는 **기술 문의가 아닌** 다른
 * 요청 종류(계약·포털 접근)다. 포털의 현재 목록(25개)에 없으므로 그쪽으로 등록하면
 * 거절된다. 고를 수 있게 두면 사람은 왜 실패했는지 알 수 없다.
 *
 * categoryId 를 아는지가 곧 "지금 올릴 수 있는가" 다 — 그 표가 포털의 현재 목록에서
 * 왔기 때문이다.
 */
export function selectableProducts<T extends { productId: number }>(
  rows: readonly T[],
): T[] {
  return rows.filter((row) => categoryIdOf(row.productId) !== null);
}
