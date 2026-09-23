/**
 * SR 작성 폼의 Product · Component 내장 목록.
 *
 * 이 선택지는 원래 수집된 케이스(cases.product_id)에서만 뽑았다. 그런데 그 값은
 * 케이스 **상세**를 받아올 때만 채워지므로(collector/api.ts 의 master.subCategoryId),
 * 목록만 수집된 환경에서는 드롭다운이 통째로 비어 버렸다. 그러면 SR 을 아예 못 쓴다.
 *
 * 그래서 실제로 우리가 올린 케이스에서 확인된 조합을 내장해 둔다. DB 에서 뽑힌 것이
 * 있으면 그쪽을 쓰고, 없을 때만 이 목록으로 채운다.
 *
 * **id 는 포털이 쓰는 실제 값이다**(subCategoryId / compId). 지어낸 값을 넣으면
 * 고른 것과 다른 제품으로 등록된다. 새 조합을 더할 때는 반드시 실제 케이스에서 확인할 것.
 *
 * 순서는 실제로 많이 쓴 순이다. 건수 자체는 싣지 않는다 — 이 저장소는 공개이고
 * 컴포넌트별 건수는 우리 업무 구성을 드러낸다.
 */
export interface CatalogEntry {
  readonly productId: number;
  readonly productName: string;
  readonly componentId: number;
  readonly componentName: string;
}

export const PRODUCT_CATALOG: readonly CatalogEntry[] = [
  { productId: 4322, productName: "VMware Tanzu Application Service", componentId: 9698, componentName: "TAS System Applications" },
  { productId: 4322, productName: "VMware Tanzu Application Service", componentId: 9695, componentName: "Diego" },
  { productId: 4322, productName: "VMware Tanzu Application Service", componentId: 9696, componentName: "Logging and Metrics" },
  { productId: 4322, productName: "VMware Tanzu Application Service", componentId: 9697, componentName: "TAS Networking" },
  { productId: 4322, productName: "VMware Tanzu Application Service", componentId: 9687, componentName: "Blobstore" },
  { productId: 4322, productName: "VMware Tanzu Application Service", componentId: 9692, componentName: "Customer Application" },
  { productId: 4322, productName: "VMware Tanzu Application Service", componentId: 9689, componentName: "CF CLI" },
  { productId: 4322, productName: "VMware Tanzu Application Service", componentId: 9693, componentName: "CVE" },
  { productId: 4322, productName: "VMware Tanzu Application Service", componentId: 9694, componentName: "Database" },
  { productId: 4322, productName: "VMware Tanzu Application Service", componentId: 9699, componentName: "UAA" },
  { productId: 4322, productName: "VMware Tanzu Application Service", componentId: 9688, componentName: "Buildpacks" },
  { productId: 4322, productName: "VMware Tanzu Application Service", componentId: 9690, componentName: "Cloud Controller" },
  { productId: 4322, productName: "VMware Tanzu Application Service", componentId: 9691, componentName: "Credhub" },
  { productId: 4322, productName: "VMware Tanzu Application Service", componentId: 9743, componentName: "VMware Tanzu RabbitMQ" },
  { productId: 4801, productName: "VMware Tanzu Platform - Cloud Foundry", componentId: 10516, componentName: "Diego" },
  { productId: 4801, productName: "VMware Tanzu Platform - Cloud Foundry", componentId: 10517, componentName: "Logging & Metrics" },
  { productId: 4801, productName: "VMware Tanzu Platform - Cloud Foundry", componentId: 10515, componentName: "Database" },
  { productId: 4801, productName: "VMware Tanzu Platform - Cloud Foundry", componentId: 10518, componentName: "TAS Networking" },
  { productId: 4801, productName: "VMware Tanzu Platform - Cloud Foundry", componentId: 10519, componentName: "TAS System Applications" },
  { productId: 4801, productName: "VMware Tanzu Platform - Cloud Foundry", componentId: 10510, componentName: "Buildpacks" },
  { productId: 4801, productName: "VMware Tanzu Platform - Cloud Foundry", componentId: 10513, componentName: "Credhub" },
  { productId: 4801, productName: "VMware Tanzu Platform - Cloud Foundry", componentId: 10514, componentName: "Customer Application" },
  { productId: 4801, productName: "VMware Tanzu Platform - Cloud Foundry", componentId: 10520, componentName: "UAA" },
  { productId: 4801, productName: "VMware Tanzu Platform - Cloud Foundry", componentId: 10511, componentName: "CF CLI" },
  { productId: 4801, productName: "VMware Tanzu Platform - Cloud Foundry", componentId: 10209, componentName: "CVE" },
  { productId: 4801, productName: "VMware Tanzu Platform - Cloud Foundry", componentId: 10324, componentName: "Healthwatch" },
  { productId: 4801, productName: "VMware Tanzu Platform - Cloud Foundry", componentId: 10509, componentName: "Blobstore" },
  { productId: 4301, productName: "Operations Manager", componentId: 10204, componentName: "Opsman Tile" },
  { productId: 4301, productName: "Operations Manager", componentId: 10206, componentName: "Opsman Components" },
  { productId: 4301, productName: "Operations Manager", componentId: 10208, componentName: "Opsman Certificates" },
  { productId: 4301, productName: "Operations Manager", componentId: 9294, componentName: "BOSH" },
  { productId: 4301, productName: "Operations Manager", componentId: 10207, componentName: "Opsman Stemcell" },
  { productId: 4301, productName: "Operations Manager", componentId: 9295, componentName: "Certificate Rotation" },
  { productId: 4301, productName: "Operations Manager", componentId: 9305, componentName: "Opsman Web UI" },
  { productId: 4332, productName: "VMware Tanzu Gemfire", componentId: 9475, componentName: "VMware Tanzu GemFire on Cloud Foundry" },
  { productId: 4332, productName: "VMware Tanzu Gemfire", componentId: 9453, componentName: "VMware Tanzu GemFire" },
  { productId: 4333, productName: "VMware Tanzu RabbitMQ", componentId: 9745, componentName: "VMware Tanzu RabbitMQ for Tanzu Platform" },
  { productId: 4333, productName: "VMware Tanzu RabbitMQ", componentId: 9743, componentName: "VMware Tanzu RabbitMQ" },
  { productId: 4284, productName: "VMware Tanzu Platform", componentId: 10298, componentName: "VMware Tanzu Platform" },
  { productId: 4289, productName: "VMware Tanzu Data Suite", componentId: 9453, componentName: "VMware Tanzu GemFire" },
  { productId: 4289, productName: "VMware Tanzu Data Suite", componentId: 9455, componentName: "VMware Tanzu RabbitMQ" },
  { productId: 4551, productName: "Product Entitlements/Contracts Related", componentId: 8464, componentName: "Default" },
  { productId: 4551, productName: "Product Entitlements/Contracts Related", componentId: 8, componentName: "Support Online General Assistance" },
  { productId: 4299, productName: "VMware Tanzu Application Service for VMs", componentId: 9682, componentName: "Diego" },
  { productId: 4299, productName: "VMware Tanzu Application Service for VMs", componentId: 9684, componentName: "TAS Networking" },
  { productId: 4320, productName: "VMware Tanzu Spring Runtime", componentId: 9870, componentName: "Spring Cloud Gateway" },
  { productId: 4320, productName: "VMware Tanzu Spring Runtime", componentId: 9748, componentName: "Spring" },
  { productId: 4550, productName: "Support Portal & Access Issues", componentId: 8464, componentName: "Default" },
  { productId: 4550, productName: "Support Portal & Access Issues", componentId: 9078, componentName: "Product Download Related" },
  { productId: 4550, productName: "Support Portal & Access Issues", componentId: 9079, componentName: "Registration/Enrollment-Admin & Additional Site Access" },
  { productId: 2, productName: "Support Portal", componentId: 8, componentName: "Support Online General Assistance" },
  { productId: 4281, productName: "VMware vSphere ESXi", componentId: 9123, componentName: "ESXi Host Management" },
  { productId: 4508, productName: "VMware Tanzu Application Platform", componentId: 10185, componentName: "Observability" },
  { productId: 4645, productName: "VMware Tanzu Data Services", componentId: 9455, componentName: "VMware Tanzu RabbitMQ" },
];

/**
 * DB 에서 뽑은 조합에 내장 목록을 더한다.
 *
 * 예전에는 "DB 가 비면 내장 목록" 이었는데, 운영 DB 에 쓸모없는 조합이 몇 개라도
 * 있으면(Support Portal, Product Entitlements 같은 것) 내장 목록이 아예 안 켜지고
 * 그 몇 개만 떴다. 정작 필요한 Tanzu 제품은 고를 수가 없었다.
 *
 * 그래서 둘을 합친다. 같은 조합은 DB 쪽을 남긴다 — 실제로 쓴 횟수(used)가 있어야
 * 많이 쓰는 것이 위로 온다. 내장분은 used 0 이라 그 뒤에 붙는다.
 */
export function mergeCatalog<T extends CatalogEntry & { used: number }>(
  fromDb: readonly T[],
): Array<CatalogEntry & { used: number }> {
  const key = (c: CatalogEntry): string => `${c.productId}:${c.componentId}`;
  const seen = new Set(fromDb.map(key));
  return [
    ...fromDb,
    ...PRODUCT_CATALOG.filter((c) => !seen.has(key(c))).map((c) => ({ ...c, used: 0 })),
  ];
}
