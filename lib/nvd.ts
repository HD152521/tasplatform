/**
 * NVD(미국 국가 취약점 DB) 조회.
 *
 * 공개 REST API 라 인증도 브라우저도 필요 없다. Broadcom 세션과 완전히 무관하게
 * 돌아가므로 세션 만료·경합 문제에서 자유롭다.
 *
 * 키워드는 우리가 실제로 지원하는 제품에서 뽑았다 (케이스 299건의 제품명 기준).
 * NVD 는 키워드 매칭이라 관련 없는 결과가 섞일 수 있어, 화면에서 걸러낼 수 있게 해 둔다.
 */
const NVD_ENDPOINT = "https://services.nvd.nist.gov/rest/json/cves/2.0";

/** 조회 키워드와, 그 결과를 어느 제품으로 묶을지. */
export const WATCH: ReadonlyArray<{ keyword: string; product: string }> = [
  // TAS 는 Cloud Foundry 기반이라 CVE 가 그 이름으로 등록된다.
  { keyword: "Cloud Foundry", product: "Cloud Foundry / TAS" },
  { keyword: "Tanzu", product: "Tanzu" },
  { keyword: "GemFire", product: "GemFire" },
  { keyword: "Spring Cloud Gateway", product: "Spring Cloud Gateway" },
  { keyword: "CredHub", product: "CredHub" },
  // RabbitMQ 는 순수 RabbitMQ 취약점이 대부분이라 우리 환경과 무관한 게 많이 섞인다.
  // 그래도 TAS 에 내장돼 있어 빼지 않고, 화면에서 제품 필터로 분리해 볼 수 있게 둔다.
  { keyword: "RabbitMQ", product: "RabbitMQ" },
];

export interface CveRecord {
  cve_id: string;
  product: string;
  keyword: string;
  severity: string;
  score: number | null;
  published: string;
  modified: string;
  summary: string;
  url: string;
  fetched_at: string;
  /** CVSS 벡터 문자열 */
  vector: string;
  /** 공격 조건 — 원격에서 인증 없이 가능한지 판단하는 핵심 값들 */
  attack_vector: string;
  attack_complexity: string;
  privileges_required: string;
  user_interaction: string;
  impact_c: string;
  impact_i: string;
  impact_a: string;
  /** 취약점 유형 (CWE) */
  cwe: string;
  /** 참고 링크 JSON 배열 */
  references_json: string;
  /** 영향 받는 제품·버전 (CPE) JSON 배열 */
  affected_json: string;
}

interface CvssData {
  baseScore?: number;
  baseSeverity?: string;
  vectorString?: string;
  attackVector?: string;
  attackComplexity?: string;
  privilegesRequired?: string;
  userInteraction?: string;
  confidentialityImpact?: string;
  integrityImpact?: string;
  availabilityImpact?: string;
}

/** configurations 안에 흩어진 CPE 조건을 사람이 읽을 수 있는 줄로 편다. */
function flattenAffected(configurations: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (typeof o["criteria"] === "string") {
      const parts = [o["criteria"] as string];
      for (const [key, label] of [
        ["versionStartIncluding", ">="],
        ["versionStartExcluding", ">"],
        ["versionEndIncluding", "<="],
        ["versionEndExcluding", "<"],
      ] as const) {
        const v = o[key];
        if (typeof v === "string") parts.push(`${label} ${v}`);
      }
      out.push(parts.join(" "));
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(configurations);
  return [...new Set(out)].slice(0, 40);
}

interface NvdResponse {
  totalResults?: number;
  vulnerabilities?: Array<{
    cve?: {
      id?: string;
      published?: string;
      lastModified?: string;
      descriptions?: Array<{ lang?: string; value?: string }>;
      metrics?: {
        cvssMetricV31?: Array<{ cvssData?: CvssData }>;
        cvssMetricV30?: Array<{ cvssData?: CvssData }>;
        cvssMetricV2?: Array<{ cvssData?: { baseScore?: number }; baseSeverity?: string }>;
      };
      weaknesses?: Array<{ description?: Array<{ lang?: string; value?: string }> }>;
      references?: Array<{ url?: string; source?: string; tags?: string[] }>;
      configurations?: unknown;
    };
  }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** NVD 는 pubStartDate~pubEndDate 범위가 120일을 넘으면 404 를 준다. */
export const MAX_RANGE_DAYS = 120;

export class NvdError extends Error {
  // Node 의 타입 스트리핑은 생성자 파라미터 프로퍼티를 지원하지 않는다.
  // 필드를 명시적으로 선언한다.
  readonly keyword: string;
  readonly status: number;
  readonly detail: string;

  constructor(keyword: string, status: number, detail: string) {
    super(`NVD 조회 실패 (${keyword}): HTTP ${status} ${detail}`.trim());
    this.name = "NvdError";
    this.keyword = keyword;
    this.status = status;
    this.detail = detail;
  }
}

function isoAt(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}.000`;
}

async function fetchWindow(
  keyword: string,
  product: string,
  fromMs: number,
  toMs: number,
): Promise<CveRecord[]> {
  const url =
    `${NVD_ENDPOINT}?keywordSearch=${encodeURIComponent(keyword)}` +
    `&pubStartDate=${isoAt(fromMs)}&pubEndDate=${isoAt(toMs)}&resultsPerPage=200`;

  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "broadcom-sr-hub/0.1" },
    signal: AbortSignal.timeout(45_000),
  });

  // 실패를 빈 결과로 흘려보내지 않는다. 0건과 "못 가져옴"은 완전히 다르다.
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 120);
    throw new NvdError(keyword, response.status, detail);
  }

  const body = (await response.json()) as NvdResponse;
  const now = new Date().toISOString();
  const out: CveRecord[] = [];

  for (const entry of body.vulnerabilities ?? []) {
    const cve = entry.cve;
    const id = cve?.id;
    if (id === undefined) continue;

    const m = cve?.metrics;
    const cvss = m?.cvssMetricV31?.[0]?.cvssData ?? m?.cvssMetricV30?.[0]?.cvssData;
    const score = cvss?.baseScore ?? m?.cvssMetricV2?.[0]?.cvssData?.baseScore ?? null;
    const severity = cvss?.baseSeverity ?? m?.cvssMetricV2?.[0]?.baseSeverity ?? "UNKNOWN";

    const cwe = (cve?.weaknesses ?? [])
      .flatMap((w) => (w.description ?? []).map((d) => d.value ?? ""))
      .filter((v) => v !== "" && v !== "NVD-CWE-noinfo" && v !== "NVD-CWE-Other");

    const references = (cve?.references ?? [])
      .map((r) => ({ url: r.url ?? "", source: r.source ?? "", tags: r.tags ?? [] }))
      .filter((r) => r.url !== "");

    out.push({
      cve_id: id,
      product,
      keyword,
      severity: severity.toUpperCase(),
      score: typeof score === "number" ? score : null,
      published: cve?.published ?? "",
      modified: cve?.lastModified ?? "",
      summary: (cve?.descriptions ?? []).find((d) => d.lang === "en")?.value ?? "",
      url: `https://nvd.nist.gov/vuln/detail/${id}`,
      fetched_at: now,
      vector: cvss?.vectorString ?? "",
      attack_vector: cvss?.attackVector ?? "",
      attack_complexity: cvss?.attackComplexity ?? "",
      privileges_required: cvss?.privilegesRequired ?? "",
      user_interaction: cvss?.userInteraction ?? "",
      impact_c: cvss?.confidentialityImpact ?? "",
      impact_i: cvss?.integrityImpact ?? "",
      impact_a: cvss?.availabilityImpact ?? "",
      cwe: [...new Set(cwe)].join(", "),
      references_json: JSON.stringify(references),
      affected_json: JSON.stringify(flattenAffected(cve?.configurations)),
    });
  }
  return out;
}

/**
 * 키워드 하나에 대한 CVE 목록.
 * 120일 한도를 넘는 기간은 여러 구간으로 나눠 조회한다.
 */
export async function fetchCves(
  keyword: string,
  product: string,
  sinceDays: number,
): Promise<CveRecord[]> {
  const day = 24 * 60 * 60 * 1000;
  const end = Date.now();
  const start = end - sinceDays * day;
  const step = MAX_RANGE_DAYS * day;

  const seen = new Map<string, CveRecord>();
  for (let from = start; from < end; from += step) {
    const to = Math.min(from + step, end);
    for (const row of await fetchWindow(keyword, product, from, to)) {
      seen.set(row.cve_id, row);
    }
    if (from + step < end) await sleep(7000);
  }
  return [...seen.values()];
}

/** 모든 감시 키워드를 순서대로 조회한다. */
export async function fetchAllCves(
  sinceDays: number,
  onProgress?: (keyword: string, count: number) => void,
): Promise<CveRecord[]> {
  const all: CveRecord[] = [];
  for (const { keyword, product } of WATCH) {
    const rows = await fetchCves(keyword, product, sinceDays);
    onProgress?.(keyword, rows.length);
    all.push(...rows);
    await sleep(7000);
  }
  return all;
}
