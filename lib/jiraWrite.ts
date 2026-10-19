/**
 * Jira 에 **쓴다** — 티켓 생성과 댓글. 이 도구에서 Jira 쪽 쓰기는 여기뿐이다.
 *
 * ## 왜 atlassian.ts 에 넣지 않나
 *
 * 그 파일은 읽기 전용이고 머리말에 "여기에 post() 를 추가하지 말 것, 쓰기가 필요해지면
 * 별도 모듈로 만들 것" 이라고 적혀 있다. 그 약속을 지킨다. lib/confluencePublish.ts 가
 * 먼저 같은 방식으로 떨어져 나왔다 — 선례를 따른다.
 *
 * 쓰는 자리는 **둘뿐**이다.
 *   1. SR 등록 직후 티켓 하나
 *   2. SR 정리 문서를 Confluence 에 올린 뒤 댓글 하나
 * 그 밖의 Jira 쓰기(상태 전이·담당자 지정)는 여기에 넣지 않는다.
 *
 * ## 꺼 둘 수 있어야 한다
 *
 * 외부에 글을 남기기 시작하는 기능이라 되돌릴 손잡이가 필요하다. `JIRA_AUTO_CREATE=1`
 * 이 아니면 아무것도 쓰지 않는다(`jiraSrConfig()` 가 null).
 *
 * ## 필수가 아닌 칸이 티켓을 막지 않는다
 *
 * Jira 가 생성 시 요구하는 것은 project·issuetype·summary 뿐이다(실측 createmeta).
 * 상위 항목·Team·시작 날짜·라벨은 **있으면 좋은 값**이다. 그 칸들의 쓰기 형식은 판본마다
 * 갈리는데(특히 Team: 문자열 id / 객체), 그것 때문에 400 이 나서 티켓이 아예 안 생기면
 * 추적할 곳이 없어진다. 그래서 400 이면 **곁가지 칸을 떼고 한 번 더** 시도한다.
 */
import "server-only";
import { atlassianConfig, AtlassianError } from "./atlassian.ts";
import type { AdfDoc } from "./adf.ts";

/**
 * Jira 를 기다리는 상한.
 *
 * **SR 은 이미 브로드컴에 올라간 뒤**다. 그런데 응답은 이 호출이 끝나야 나간다. Jira 가
 * 느리면 사람은 SR 이 안 올라간 줄 알고 다시 등록해 **중복 케이스**를 만든다 — 이
 * 프로젝트에서 가장 비싼 실패다. 그래서 짧게 끊는다. 티켓은 못 만들어도 SR 은 올라갔다.
 */
const TIMEOUT_MS = 10_000;

/**
 * 티켓이 **만들어졌을 수도 있는** 실패.
 *
 * 400(검증 거절)·401·403 은 아무것도 만들어지지 않는다. 그런데 타임아웃·망 오류·5xx 는
 * 서버가 이미 받아 처리했는데 응답만 못 받은 경우일 수 있다. 그 둘을 섞으면 "못 만들었다,
 * 직접 만드세요" 라고 안내해 **티켓이 두 개** 된다.
 */
export class JiraMaybeCreatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraMaybeCreatedError";
  }
}

/** 기존 SR 티켓들이 쓰는 라벨. 이걸로 찾는다. */
export const SR_LABEL = "TAS_SR";

/** 이슈 타입. 최근 SR 티켓들이 쓰는 `작업`. 환경변수로 바꿀 수 있다. */
const DEFAULT_ISSUE_TYPE = "작업";

export interface JiraSrConfig {
  readonly base: string;
  readonly email: string;
  readonly token: string;
  readonly projectKey: string;
  /** 상위 항목(에픽) 키. 비면 상위 항목 없이 만든다. */
  readonly epicKey: string;
  readonly issueTypeName: string;
  /** Team 필드(customfield_10001) 값. 비면 넣지 않는다. */
  readonly teamId: string;
}

/**
 * 설정. 하나라도 모자라면 null — 부르는 쪽이 "안 함" 으로 처리한다.
 *
 * `JIRA_SR_PROJECT` 를 따로 둔다. `JIRA_PROJECT` 는 월간 보고서의 작업 조회가 이미
 * 쓰고 있어서, 한 값을 두 용도로 쓰다가 한쪽을 바꾸면 다른 쪽이 조용히 따라간다.
 * 비어 있으면 `JIRA_PROJECT` 로 떨어진다(지금은 같은 프로젝트다).
 */
export function jiraSrConfig(): JiraSrConfig | null {
  if ((process.env.JIRA_AUTO_CREATE ?? "").trim() !== "1") return null;

  const atlassian = atlassianConfig();
  if (atlassian === null) return null;

  const projectKey = (process.env.JIRA_SR_PROJECT ?? "").trim() || atlassian.jiraProject;
  if (projectKey === "") return null;

  return {
    base: atlassian.base,
    email: atlassian.email,
    token: atlassian.token,
    projectKey,
    epicKey: (process.env.JIRA_SR_EPIC ?? "").trim(),
    issueTypeName: (process.env.JIRA_SR_ISSUETYPE ?? "").trim() || DEFAULT_ISSUE_TYPE,
    teamId: (process.env.JIRA_SR_TEAM_ID ?? "").trim(),
  };
}

function authHeader(config: JiraSrConfig): string {
  return `Basic ${Buffer.from(`${config.email}:${config.token}`, "utf8").toString("base64")}`;
}

async function jfetch<T>(
  config: JiraSrConfig,
  method: "POST",
  path: string,
  body: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${config.base}${path}`, {
      method,
      headers: {
        Authorization: authHeader(config),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    // 타임아웃·망 오류. **보냈는데 답을 못 받은 것**이라 만들어졌는지 알 수 없다.
    throw new JiraMaybeCreatedError(
      error instanceof Error && error.name === "TimeoutError"
        ? `Jira 가 ${TIMEOUT_MS / 1000}초 안에 답하지 않았습니다.`
        : `Jira 에 닿지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const raw = await response.text();
  if (!response.ok) {
    // 5xx 는 서버가 이미 받아 처리했을 수 있다. 4xx 는 받지 않은 것이다.
    if (response.status >= 500) {
      throw new JiraMaybeCreatedError(`Jira 서버 오류 (HTTP ${response.status}).`);
    }
    throw new AtlassianError(response.status, path, raw.slice(0, 400));
  }
  return (raw === "" ? {} : JSON.parse(raw)) as T;
}

/** 오늘 날짜(YYYY-MM-DD). Jira 의 날짜 칸은 시각이 아니라 날짜만 받는다. */
function today(): string {
  // 한국 시간 기준. 서버가 UTC 면 자정 무렵에 하루 전으로 적힐 수 있어 보정한다.
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

export interface CreatedIssue {
  readonly key: string;
  readonly url: string;
  /** 떼고 다시 시도한 칸들. 비어 있으면 한 번에 들어갔다. */
  readonly dropped: readonly string[];
}

/**
 * SR 티켓 하나를 만든다.
 *
 * 실패는 **던진다.** 삼키면 "티켓이 없는 SR" 이 조용히 생기고, 그러면 SR 이 끝난 뒤
 * 댓글을 달 곳이 없다. 부르는 쪽(라우트)이 잡아서 SR 등록 자체는 성공으로 둔다.
 */
export async function createSrIssue(
  config: JiraSrConfig,
  input: { summary: string; description: AdfDoc },
): Promise<CreatedIssue> {
  /** 없어도 티켓이 성립하는 칸들. 400 이 나면 이것부터 뗀다. */
  const extras: Record<string, unknown> = {
    labels: [SR_LABEL],
    // 시작 날짜 = 올린 날짜.
    customfield_10015: today(),
  };
  if (config.epicKey !== "") extras["parent"] = { key: config.epicKey };
  if (config.teamId !== "") extras["customfield_10001"] = config.teamId;

  const required = {
    project: { key: config.projectKey },
    issuetype: { name: config.issueTypeName },
    summary: input.summary,
    description: input.description,
  };

  try {
    const made = await jfetch<{ key?: string }>(config, "POST", "/rest/api/3/issue", {
      fields: { ...required, ...extras },
    });
    return { key: requireKey(made.key), url: issueUrl(config, requireKey(made.key)), dropped: [] };
  } catch (error) {
    // 400 은 "어느 칸의 모양이 틀렸다" 는 뜻이다. 곁가지 칸을 다 떼고 한 번만 더 본다 —
    // 어느 칸인지 응답에서 골라내려 들면 Jira 판본마다 메시지가 달라 또 어긋난다.
    if (!(error instanceof AtlassianError) || error.status !== 400) throw error;
    console.error(
      `[jira] 티켓 생성 400 — 곁가지 칸(${Object.keys(extras).join(", ")})을 떼고 다시 시도합니다: ${error.message}`,
    );
    const made = await jfetch<{ key?: string }>(config, "POST", "/rest/api/3/issue", {
      fields: required,
    });
    return {
      key: requireKey(made.key),
      url: issueUrl(config, requireKey(made.key)),
      dropped: Object.keys(extras),
    };
  }
}

/**
 * 그 티켓에 **이미** 이 문서 링크를 담은 댓글이 있는가.
 *
 * ## 왜 쓰기 모듈에 읽기가 들어오나
 *
 * 쓰기를 **안전하게 다시 시도하기 위한** 읽기다. 댓글은 보냈는지 모르는 상태로 실패할
 * 수 있다 — 타임아웃·5xx 는 서버가 이미 받아 처리했는데 응답만 못 받은 경우일 수 있고,
 * 보내기는 성공했는데 "달았다" 표시만 실패할 수도 있다. 그 둘을 "안 달렸다" 로 보고
 * 다시 보내면 **같은 티켓에 댓글이 두 번** 달린다.
 *
 * 그래서 다시 보내기 전에 물어본다. 문서 주소는 그 SR 에만 쓰는 값이라 표식으로 알맞다.
 *
 * 못 물어보면(망 오류 등) **false 로 둔다.** 그러면 한 번 더 보낼 수 있는데, 댓글 하나가
 * 더 달리는 것이 결과가 영영 안 달리는 것보다 가볍다.
 */
export async function hasCommentWithLink(
  config: JiraSrConfig,
  issueKey: string,
  pageUrl: string,
): Promise<boolean> {
  if (pageUrl === "") return false;
  try {
    const response = await fetch(
      `${config.base}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?maxResults=50`,
      {
        headers: { Authorization: authHeader(config), Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!response.ok) return false;
    // ADF 를 뜯지 않는다. 주소가 글자로 들어 있으면(링크 마크의 href 든 본문이든) 그것이다.
    return (await response.text()).includes(pageUrl);
  } catch {
    return false;
  }
}

/** 티켓 한 건에 댓글 하나. */
export async function addSrComment(
  config: JiraSrConfig,
  issueKey: string,
  body: AdfDoc,
): Promise<void> {
  await jfetch(config, "POST", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, { body });
}

/**
 * 200 을 받았으면 키가 있어야 한다. 없으면 **만들어졌는지 모르는** 상태다 —
 * "못 만들었다" 고 안내하면 사람이 하나 더 만든다.
 */
function requireKey(key: string | undefined): string {
  if (key === undefined || key === "") {
    throw new JiraMaybeCreatedError("Jira 가 티켓 번호를 주지 않았습니다.");
  }
  return key;
}

export function issueUrl(config: JiraSrConfig, issueKey: string): string {
  return issueKey === "" ? "" : `${config.base}/browse/${issueKey}`;
}
