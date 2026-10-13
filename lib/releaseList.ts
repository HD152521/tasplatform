/**
 * 그 제품의 Release 목록 — 포털에 **그때그때 물어본다.**
 *
 * ## 왜 박아 두지 않나
 *
 * 제품당 건수가 이렇다(2026-10-13 실측).
 *
 *     TAS                 6,084
 *     TPCF                6,129
 *     Operations Manager    168
 *     GemFire               144
 *
 * TAS·TPCF 는 야간 빌드(`2026-03-02_080902`)까지 들어 있어 수천 건이다.
 * PRODUCT_CATALOG 처럼 내장할 수 없다.
 *
 * ## 왜 고쳐야 했나
 *
 * 등록 payload 의 `releaseId` 가 템플릿 고정값 **798** 이었다. 그 값은
 * **GemFire 10.4.2** 다 — TAS 의 버전 체계는 `2603.4.3`·`2412.10.14`·`2022.4.829` 로
 * 10.x 가 아예 없다. 즉 제품은 TAS 인데 release 는 GemFire 인 SR 이 계속 올라갔다.
 *
 * ## API 계약 (캡처로 확인)
 *
 *     POST {API_ORIGIN}/wlkn-reports/ext_data_push/pull
 *       dataApiName = itemReleaseList
 *       data        = {"categoryId": n, "releaseId": "<검색어>", "limit": n, "offset": n}
 *     → {"status":"success","data":[{"releaseId":798,"releaseDesc":"10.4.2"}, ...]}
 *
 * 포털 작성 폼의 `Prod Release` 가 쓰는 바로 그 조회다(typeName "Look Up", minChar 1).
 * 검색어가 비면 전체를 돌려준다. `categoryId` 가 비면 **빈 목록**이 온다 — 제품을
 * 먼저 정해야 한다.
 *
 * server-only 를 붙이지 않는다. 라우트와 수집기 양쪽에서 부른다.
 */
import { API_HEADERS, API_ORIGIN } from "./config.ts";

export interface Release {
  readonly releaseId: number;
  readonly releaseDesc: string;
}

/** 조회에 쓰는 최소 클라이언트. collector/httpClient.ts 의 ApiClient 와 같은 모양이다. */
export interface ReleaseLookupClient {
  post(url: string, options: {
    multipart: Record<string, string>;
    headers?: Record<string, string>;
  }): Promise<{ status(): number; text(): Promise<string> }>;
}

/**
 * 야간 빌드. `2026-03-02_080902` 모양.
 *
 * 사람이 고르는 버전이 아니다. TAS 의 6천 건 중 대부분이 이것이고, 걸러내지 않으면
 * 검색 결과가 빌드 타임스탬프로 덮여 정작 쓸 버전이 안 보인다.
 */
const NIGHTLY = /^\d{4}-\d{2}-\d{2}_\d{6}$/;

/** 한 번에 받아올 상한. 전체를 다 받을 필요는 없다 — 검색어로 좁혀 쓴다. */
const PAGE = 300;

export class ReleaseLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseLookupError";
  }
}

/**
 * 그 분류의 release 를 찾는다. `search` 가 비면 최신 쪽부터 돌려준다.
 *
 * 야간 빌드는 **걸러낸다.** 실패는 던진다 — 빈 배열로 삼키면 "그 제품에 release 가
 * 없다" 와 구분이 안 되고, 사람은 왜 고를 것이 없는지 알 수 없다.
 */
export async function findReleases(
  client: ReleaseLookupClient,
  categoryId: number,
  search = "",
): Promise<Release[]> {
  const response = await client.post(`${API_ORIGIN}/wlkn-reports/ext_data_push/pull`, {
    multipart: {
      dataApiName: "itemReleaseList",
      data: JSON.stringify({ categoryId, releaseId: search, limit: PAGE, offset: 0 }),
    },
    headers: API_HEADERS,
  });

  const status = response.status();
  const raw = await response.text();
  if (status === 401 || status === 403) {
    throw new ReleaseLookupError("세션이 만료되었습니다. 다시 로그인하세요.");
  }
  if (status !== 200) {
    throw new ReleaseLookupError(`Release 목록을 받지 못했습니다 (HTTP ${status}).`);
  }

  let rows: unknown;
  try {
    rows = (JSON.parse(raw) as { data?: unknown }).data;
  } catch {
    throw new ReleaseLookupError("Release 목록을 해석하지 못했습니다.");
  }
  if (!Array.isArray(rows)) {
    throw new ReleaseLookupError("Release 목록 모양이 예상과 다릅니다.");
  }

  return rows.flatMap((row) => {
    const entry = row as { releaseId?: unknown; releaseDesc?: unknown };
    const id = typeof entry.releaseId === "number" ? entry.releaseId : Number(entry.releaseId);
    const desc = typeof entry.releaseDesc === "string" ? entry.releaseDesc.trim() : "";
    if (!Number.isSafeInteger(id) || id <= 0 || desc === "" || NIGHTLY.test(desc)) return [];
    return [{ releaseId: id, releaseDesc: desc }];
  });
}

/**
 * 적어 둔 글에서 버전처럼 보이는 토막을 뽑는다. 긴 것부터 돌려준다.
 *
 * 간단히 올리기는 한 칸에 적는 자리라 버전도 그 안에 섞여 있다. "TPCF 10.4 에서…",
 * "2402.8.20.1 로 올린 뒤…" 처럼.
 *
 * 긴 것부터 내는 이유는 `10.4.2` 와 `10.4` 가 둘 다 걸릴 때 **더 구체적인 쪽**을 먼저
 * 맞춰 봐야 하기 때문이다. 짧은 쪽을 먼저 쓰면 10.4.10 같은 다른 버전에 걸린다.
 */
export function versionCandidates(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b\d+(?:\.\d+){1,3}\b/g)) found.add(match[0]);
  return [...found].sort((a, b) => b.length - a.length);
}

/**
 * 뽑은 토막을 목록과 맞춘다. 맞는 것이 없으면 null.
 *
 * **정확히 같은 것만** 받는다. `10.4` 로 `10.4.10` 을 고르면 다른 버전으로 등록된다 —
 * 비슷한 것을 골라 주는 편의가 틀린 등록보다 낫지 않다. 사람이 적은 그대로 없으면
 * 비워 두고 화면에서 고르게 한다.
 */
export function matchRelease(releases: readonly Release[], text: string): Release | null {
  for (const candidate of versionCandidates(text)) {
    const hit = releases.find((r) => r.releaseDesc === candidate);
    if (hit !== undefined) return hit;
  }
  return null;
}
