/**
 * 노션 호출.
 *
 * ## 이 파일은 **밖으로 나가는 쓰기**다
 *
 * 사내망 도구에서 공개 SaaS(api.notion.com)로 글을 보낸다. 그래서 세 가지를 지킨다.
 *
 *   1. **설정이 없으면 아무것도 하지 않는다.** 토큰과 올릴 부모 페이지를 둘 다 받아야
 *      동작한다. 하나라도 비면 `notionConfig()` 가 null 이고, 화면은 "설정 안 됨" 을
 *      그대로 보여 준다(lib/atlassian.ts 와 같은 규약).
 *   2. **사람이 고른 메모만 나간다.** 자동으로 올리는 길을 두지 않았다 — 메모장에는
 *      고객사 상황이 적힐 수 있고, 올린 글은 지워도 이미 읽힌 뒤다.
 *   3. **글 내용을 로그에 남기지 않는다.** 실패 사유에 응답 본문을 붙이는데, 그건
 *      노션이 돌려준 오류 설명이고 우리가 보낸 글이 아니다.
 *
 * ## 왜 토큰을 환경변수로 받나
 *
 * DB(설정 화면)에 두려면 암호화 키(SR_SECRET_KEY)가 있어야 하고, 그게 아직 없다
 * (lib/portalCredentials.ts — 평문 폴백은 두지 않는다). Jira 와 같은 방식으로 환경변수를
 * 먼저 쓴다. 키가 생기면 포털 자격처럼 DB 로 옮기면 된다.
 *
 * ## 부모는 **페이지**다, 데이터베이스가 아니다
 *
 * 데이터베이스에 넣으면 그 DB 의 속성(필드)을 맞춰야 하고, 속성은 사람이 노션에서
 * 언제든 바꾼다 — 그때마다 우리 쪽이 400 으로 멈춘다. 페이지 자식으로 만들면 제목
 * 하나만 맞추면 된다. 노션에서 나중에 DB 로 옮기는 것은 사람이 끌어다 하면 된다.
 *
 * 노션에서 **그 부모 페이지를 이 integration 에 공유**해 두어야 한다. 안 하면 404 가
 * 온다(없는 페이지와 권한 없는 페이지를 노션은 같은 404 로 답한다 — 그래서 아래에서
 * 그 404 에만 안내를 붙인다).
 */
import "server-only";

/** 노션 API 버전. 날짜 문자열이고, 바꾸면 응답 모양이 바뀐다 — 손으로만 올린다. */
const NOTION_VERSION = "2022-06-28";

const NOTION_API = "https://api.notion.com/v1";

export class NotionError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`노션 요청 실패 (HTTP ${status}): ${detail}`.trim());
    this.name = "NotionError";
    this.status = status;
  }
}

export interface NotionConfig {
  readonly token: string;
  /** 메모 페이지를 이 페이지의 자식으로 만든다. */
  readonly parentPageId: string;
}

/**
 * 설정을 읽는다. 하나라도 비면 null — 화면이 "설정 안 됨" 을 그대로 보여 준다.
 *
 * 페이지 id 는 노션 주소 끝의 32자 16진수다. 사람이 주소를 그대로 붙여 넣는 일이
 * 흔하므로 여기서 걷어낸다 — 안 하면 404 가 오고, 그 404 는 "공유를 안 했다" 와
 * 구분이 안 된다.
 */
export function notionConfig(): NotionConfig | null {
  const token = (process.env.NOTION_TOKEN ?? "").trim();
  const parent = normalizePageId(process.env.NOTION_PARENT_PAGE ?? "");
  if (token === "" || parent === "") return null;
  return { token, parentPageId: parent };
}

/**
 * 노션 주소나 id 에서 32자 id 만 꺼낸다.
 *
 *   https://www.notion.so/team/제목-1a2b...          → 1a2b...
 *   1a2b3c4d-5e6f-...                                 → 1a2b3c4d5e6f...
 *
 * 못 알아보면 빈 문자열이다. 추측해 보내면 404 가 오고 사람은 무엇이 틀렸는지 모른다.
 */
export function normalizePageId(raw: string): string {
  const text = raw.trim();
  if (text === "") return "";
  const hits = text.toLowerCase().match(/[0-9a-f]{32}/g);
  if (hits !== null && hits.length > 0) return hits[hits.length - 1] as string;
  // 하이픈이 섞인 UUID.
  const dashed = text.toLowerCase().match(/[0-9a-f-]{36}/g);
  if (dashed !== null && dashed.length > 0) {
    const stripped = (dashed[dashed.length - 1] as string).replace(/-/g, "");
    if (/^[0-9a-f]{32}$/.test(stripped)) return stripped;
  }
  return "";
}

async function nfetch<T>(
  config: NotionConfig,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${NOTION_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Notion-Version": NOTION_VERSION,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    // 망에 못 닿은 것과 거절당한 것은 사람이 할 일이 다르다. 0 으로 구분한다.
    throw new NotionError(0, error instanceof Error ? error.message : String(error));
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new NotionError(response.status, detail.slice(0, 500));
  }
  // DELETE 도 본문을 돌려주지만 쓰지 않는다. 비어 있어도 터지지 않게 받는다.
  const text = await response.text().catch(() => "");
  return (text === "" ? {} : JSON.parse(text)) as T;
}

export interface NotionPage {
  readonly pageId: string;
  readonly url: string;
}

interface PageResponse {
  id?: string;
  url?: string;
}

/**
 * 부모 페이지 아래에 새 페이지를 만든다.
 *
 * 블록은 **첫 100개만** 함께 보낸다. 나머지는 appendBlocks 로 잇는다 — 한 요청에
 * 100개를 넘기면 노션이 요청 전체를 거절한다.
 */
export async function createPage(
  config: NotionConfig,
  input: { readonly title: string; readonly blocks: readonly unknown[] },
): Promise<NotionPage> {
  const body = {
    parent: { type: "page_id", page_id: config.parentPageId },
    properties: {
      title: { title: [{ type: "text", text: { content: input.title.slice(0, 2000) } }] },
    },
    children: input.blocks.slice(0, 100),
  };
  const page = await nfetch<PageResponse>(config, "POST", "/pages", body);
  const pageId = (page.id ?? "").replace(/-/g, "");
  if (pageId === "") {
    // id 가 없으면 다음 올리기가 이 페이지를 못 찾아 같은 글로 하나 더 만든다.
    throw new NotionError(0, "응답에 페이지 id 가 없습니다.");
  }
  return { pageId, url: page.url ?? "" };
}

/** 페이지 제목을 고친다. */
export async function updateTitle(
  config: NotionConfig,
  pageId: string,
  title: string,
): Promise<void> {
  await nfetch(config, "PATCH", `/pages/${pageId}`, {
    properties: {
      title: { title: [{ type: "text", text: { content: title.slice(0, 2000) } }] },
    },
  });
}

export async function appendBlocks(
  config: NotionConfig,
  pageId: string,
  blocks: readonly unknown[],
): Promise<void> {
  if (blocks.length === 0) return;
  await nfetch(config, "PATCH", `/blocks/${pageId}/children`, { children: blocks });
}

interface ChildrenResponse {
  results?: Array<{ id?: string }>;
  next_cursor?: string | null;
  has_more?: boolean;
}

/** 페이지의 1단 자식 블록 id 목록. 한 번에 100개씩 끝까지 읽는다. */
export async function listChildBlockIds(
  config: NotionConfig,
  pageId: string,
): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | null = null;
  // 끝없이 돌지 않게 막는다. 메모 한 건이 수천 블록이 될 일은 없다.
  for (let page = 0; page < 20; page += 1) {
    const query: string = cursor === null ? "" : `?start_cursor=${encodeURIComponent(cursor)}`;
    const body: ChildrenResponse = await nfetch<ChildrenResponse>(
      config,
      "GET",
      `/blocks/${pageId}/children${query}`,
    );
    for (const row of body.results ?? []) {
      if (typeof row.id === "string" && row.id !== "") out.push(row.id);
    }
    if (body.has_more !== true || typeof body.next_cursor !== "string") break;
    cursor = body.next_cursor;
  }
  return out;
}

/**
 * 블록 하나를 지운다(노션에서는 휴지통으로 간다 — 되돌릴 수 있다).
 *
 * 노션에는 "페이지 내용을 통째로 바꾸기" 가 없다. 그래서 다시 올릴 때는 **있던 자식을
 * 지우고 새로 붙인다.** 지우기가 중간에 실패하면 옛 글과 새 글이 섞여 남는데, 그걸
 * 조용히 넘기지 않고 부르는 쪽이 사람에게 말한다.
 */
export async function deleteBlock(config: NotionConfig, blockId: string): Promise<void> {
  await nfetch(config, "DELETE", `/blocks/${blockId}`);
}

/**
 * 실패를 사람 말로.
 *
 * 노션의 404 는 **"없는 페이지" 와 "공유받지 못한 페이지" 를 구분하지 않는다.** 실제로
 * 거의 항상 후자다(integration 에 페이지를 공유하는 것을 잊는다). 그래서 그 404 에만
 * 할 일을 붙여 준다 — 사유만 보여 주면 사람은 id 를 의심하며 시간을 버린다.
 */
export function notionFailureText(error: unknown): string {
  if (!(error instanceof NotionError)) {
    return error instanceof Error ? error.message : String(error);
  }
  if (error.status === 0) {
    return `노션에 닿지 못했습니다. 이 서버에서 api.notion.com 으로 나가는 길이 막혀 있을 수 있습니다. (${error.message})`;
  }
  if (error.status === 404) {
    return "노션이 페이지를 찾지 못했습니다. 노션에서 그 페이지를 integration 에 공유했는지, NOTION_PARENT_PAGE 가 맞는지 확인하세요.";
  }
  if (error.status === 401) {
    return "노션 토큰이 거절당했습니다(NOTION_TOKEN).";
  }
  if (error.status === 429) {
    return "노션이 요청을 너무 자주 받았다고 합니다. 잠시 후 다시 올려주세요.";
  }
  return error.message;
}
