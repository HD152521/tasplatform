/**
 * Atlassian Cloud (Jira · Confluence) 호출.
 *
 * ★ 읽기 전용이다. GET 만 있고 쓰기 함수는 일부러 두지 않았다.
 *   collector/api.ts 와 같은 원칙이다 — 쓰기가 필요해지면 그때 별도 모듈에
 *   사람 확인 게이트와 함께 만든다. 여기에 post() 를 추가하지 말 것.
 *
 * Jira 와 Confluence 는 같은 사이트·같은 토큰을 쓴다.
 *   Jira        {base}/rest/api/3/...
 *   Confluence  {base}/wiki/rest/api/...
 */
import "server-only";

export class AtlassianError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string, detail: string) {
    super(`Atlassian 요청 실패 (HTTP ${status}): ${detail}`.trim());
    this.name = "AtlassianError";
    this.status = status;
    this.url = url;
  }
}

export interface AtlassianConfig {
  base: string;
  email: string;
  token: string;
  jiraProject: string;
  confluenceSpace: string;
  confluenceParentId: string;
}

/** 설정을 읽는다. 하나라도 비면 null — 화면에서 "설정 안 됨"을 그대로 보여주기 위함이다. */
export function atlassianConfig(): AtlassianConfig | null {
  const base = (process.env.ATLASSIAN_BASE ?? "").trim().replace(/\/+$/, "");
  const email = (process.env.ATLASSIAN_EMAIL ?? "").trim();
  const token = (process.env.ATLASSIAN_TOKEN ?? "").trim();
  if (base === "" || email === "" || token === "") return null;
  return {
    base,
    email,
    token,
    jiraProject: (process.env.JIRA_PROJECT ?? "").trim(),
    confluenceSpace: (process.env.CONFLUENCE_SPACE ?? "").trim(),
    confluenceParentId: (process.env.CONFLUENCE_PARENT_ID ?? "").trim(),
  };
}

export function hasAtlassian(): boolean {
  return atlassianConfig() !== null;
}

function authHeader(config: AtlassianConfig): string {
  return `Basic ${Buffer.from(`${config.email}:${config.token}`, "utf8").toString("base64")}`;
}

/**
 * GET 한 번. 실패는 던진다 — 빈 배열로 삼키면 "이슈 없음"과 구분이 안 된다.
 */
export async function get<T>(
  config: AtlassianConfig,
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(path.startsWith("http") ? path : `${config.base}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await fetch(url, {
    headers: { Authorization: authHeader(config), Accept: "application/json" },
    signal: AbortSignal.timeout(45_000),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new AtlassianError(response.status, url.toString(), raw.slice(0, 200));
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new AtlassianError(response.status, url.toString(), "응답을 해석하지 못했습니다.");
  }
}

/** 연결 확인용. 로그인한 계정 이름을 돌려준다. */
export async function whoAmI(config: AtlassianConfig): Promise<string> {
  const me = await get<{ displayName?: string; emailAddress?: string }>(
    config,
    "/rest/api/3/myself",
  );
  return me.displayName ?? me.emailAddress ?? "(이름 없음)";
}
