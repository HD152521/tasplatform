/**
 * 요약(Confluence 문서)을 실제 Confluence 에 올린다 — 쓰기 모듈.
 *
 * atlassian.ts 는 읽기 전용이라(원칙), 쓰기는 여기 따로 둔다. 화면에서 사람이 버튼을
 * 누를 때만 호출된다. "04. SR" 폴더(CONFLUENCE_PARENT_ID) 아래에
 * 제목 `[SR <넘버>] <제목>` 으로 페이지를 만든다. 같은 제목이 있으면 새로 만들지 않고 갱신한다.
 *
 * 폴더가 부모라 v2 API(/wiki/api/v2/pages, parentId 에 폴더 id 허용)를 쓴다.
 */
import "server-only";
import { atlassianConfig, AtlassianError, type AtlassianConfig } from "./atlassian.ts";
import { getCase } from "./queries.ts";
import { openDb } from "./db.ts";
import { toConfluenceStorage } from "./confluenceStorage.ts";

interface V2Page {
  id: string;
  title?: string;
  version?: { number?: number };
  _links?: { webui?: string };
}
interface V2List<T> { results?: T[] }

function authHeader(config: AtlassianConfig): string {
  return `Basic ${Buffer.from(`${config.email}:${config.token}`, "utf8").toString("base64")}`;
}

async function cfetch<T>(
  config: AtlassianConfig,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: authHeader(config),
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${config.base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const raw = await response.text();
  if (!response.ok) throw new AtlassianError(response.status, path, raw.slice(0, 300));
  return (raw === "" ? {} : JSON.parse(raw)) as T;
}

function pageUrl(base: string, page: V2Page): string {
  const webui = page._links?.webui ?? "";
  return webui === "" ? `${base}/wiki` : `${base}/wiki${webui}`;
}

export interface PublishResult {
  url: string;
  created: boolean;
}

/** 케이스의 캐시된 Confluence 요약을 실제 Confluence 페이지로 올린다(있으면 갱신). */
export async function publishSummaryToConfluence(requestId: number): Promise<PublishResult> {
  const config = atlassianConfig();
  if (config === null) {
    throw new Error("Atlassian 설정이 없습니다 (ATLASSIAN_BASE/EMAIL/TOKEN).");
  }
  if (config.confluenceSpace === "" || config.confluenceParentId === "") {
    throw new Error("CONFLUENCE_SPACE / CONFLUENCE_PARENT_ID 가 설정되지 않았습니다.");
  }

  // 1) 캐시된 요약(Confluence 문서). 없으면 먼저 만들라고 알린다.
  const db = await openDb();
  let content: string;
  try {
    const rows = (await db.all(
      "SELECT content FROM case_summaries WHERE request_id = ? AND kind = 'confluence'",
      [requestId],
    )) as Array<{ content: string }>;
    if (rows[0] === undefined) {
      throw new Error("먼저 'Confluence 문서' 요약을 만든 뒤 올려주세요.");
    }
    content = rows[0].content;
  } finally {
    await db.close();
  }

  const detail = await getCase(requestId);
  if (detail === null) throw new Error("케이스를 찾을 수 없습니다.");
  const title = `[SR ${detail.request_id_formatted}] ${detail.subject}`.trim();
  const storage = toConfluenceStorage(content);

  // 2) 스페이스 키 → spaceId
  const spaces = await cfetch<V2List<{ id: string }>>(
    config,
    "GET",
    `/wiki/api/v2/spaces?keys=${encodeURIComponent(config.confluenceSpace)}`,
  );
  const spaceId = spaces.results?.[0]?.id;
  if (spaceId === undefined) {
    throw new Error(`Confluence 스페이스를 찾지 못했습니다: ${config.confluenceSpace}`);
  }

  // 3) 같은 제목 페이지가 이미 있으면 갱신, 없으면 생성.
  const existing = await cfetch<V2List<V2Page>>(
    config,
    "GET",
    `/wiki/api/v2/pages?title=${encodeURIComponent(title)}&space-id=${spaceId}&status=current`,
  );
  const found = (existing.results ?? []).find((p) => p.title === title);

  if (found !== undefined) {
    const current = await cfetch<V2Page>(config, "GET", `/wiki/api/v2/pages/${found.id}`);
    const nextVersion = (current.version?.number ?? 1) + 1;
    const updated = await cfetch<V2Page>(config, "PUT", `/wiki/api/v2/pages/${found.id}`, {
      id: found.id,
      status: "current",
      title,
      body: { representation: "storage", value: storage },
      version: { number: nextVersion, message: "SR 자동 갱신" },
    });
    return { url: pageUrl(config.base, updated), created: false };
  }

  const created = await cfetch<V2Page>(config, "POST", "/wiki/api/v2/pages", {
    spaceId,
    status: "current",
    title,
    parentId: config.confluenceParentId,
    body: { representation: "storage", value: storage },
  });
  return { url: pageUrl(config.base, created), created: true };
}
