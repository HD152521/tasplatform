/**
 * Jira 에 **쓴다** — 티켓 생성과 댓글. 이 도구에서 Jira 쪽 쓰기는 여기뿐이다.
 *
 * ## 왜 atlassian.ts 에 넣지 않나
 *
 * 그 파일은 읽기 전용이고 머리말에 "여기에 post() 를 추가하지 말 것, 쓰기가 필요해지면
 * 별도 모듈로 만들 것" 이라고 적혀 있다. 그 약속을 지킨다. lib/confluencePublish.ts 가
 * 먼저 같은 방식으로 떨어져 나왔다 — 선례를 따른다.
 *
 * 쓰는 자리는 셋이다.
 *   1. SR 등록 직후 티켓 하나
 *   2. SR 정리 문서를 Confluence 에 올린 뒤 댓글 하나
 *   3. 팀 캘린더의 일정(lib/calendarJira.ts) — 생성·수정·상태 전이·삭제
 *
 * 3번이 들어오면서 **상태 전이와 삭제**가 생겼다. 전에 이 머리말은 "그 밖의 쓰기는
 * 넣지 않는다" 고 적혀 있었다. 그 선을 옮기는 결정은 사용자의 지시였다(일정을 지우면
 * 이슈도 지우고, 상태가 바뀌면 전이한다 — docs/plans/team-platform-plan.md S5).
 * 둘 다 **되돌릴 수 없는** 동작이므로, 각 함수 머리말에 무엇을 조심해야 하는지 적어 둔다.
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
  method: "GET" | "POST" | "PUT" | "DELETE",
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
      // GET·DELETE 에 본문을 실으면 게이트웨이가 거부하는 경우가 있다.
      ...(method === "GET" || method === "DELETE" ? {} : { body: JSON.stringify(body) }),
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

  return createIssue(config, required, extras);
}

/**
 * 이슈 하나를 만든다 — **SR 전용이 아닌** 일반 경로.
 *
 * `required` 는 Jira 가 생성에 반드시 요구하는 칸(project·issuetype·summary)이고,
 * `extras` 는 없어도 티켓이 성립하는 칸이다. 400 이 오면 extras 를 **다 떼고** 한 번
 * 더 보낸다 — 어느 칸이 문제인지 응답에서 골라내려 들면 Jira 판본마다 메시지가 달라
 * 또 어긋난다(이 폴백은 createSrIssue 가 쓰던 것을 그대로 옮긴 것이다).
 *
 * 캘린더 쪽의 새 칸(duedate·assignee·멱등 라벨)도 extras 에 넣는다. 커스텀필드 id 와
 * assignee 모양은 인스턴스마다 갈리므로, 이 폴백이 유일한 안전망이다.
 */
export async function createIssue(
  config: JiraSrConfig,
  required: Record<string, unknown>,
  extras: Record<string, unknown>,
): Promise<CreatedIssue> {
  try {
    const made = await jfetch<{ key?: string }>(config, "POST", "/rest/api/3/issue", {
      fields: { ...required, ...extras },
    });
    return { key: requireKey(made.key), url: issueUrl(config, requireKey(made.key)), dropped: [] };
  } catch (error) {
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

/* ------------------------------------------------------------------ *
 * 본문(description) 읽고 쓰기
 *
 * SR 이 끝나면 티켓 본문 끝에 조치 방향과 정리 문서 주소를 적는다. 등록 때 만든 본문에는
 * 문제 상황만 있어서다(lib/jiraSolution.ts 머리말).
 *
 * **읽고 나서 쓴다.** 본문을 통째로 갈아 끼우는 API 라, 읽지 않고 쓰면 사람이 적어 둔
 * 글이 사라진다.
 * ------------------------------------------------------------------ */

/**
 * 티켓의 현재 본문(ADF). 비어 있으면 null.
 *
 * 모양을 믿지 않고 그대로 돌려준다 — 판정은 순수 함수가 한다(lib/jiraSolution.ts 의
 * solutionPatch 가 ADF 문서인지 본다).
 */
export async function fetchIssueDescription(
  config: JiraSrConfig,
  issueKey: string,
): Promise<unknown> {
  const got = await jfetch<{ fields?: { description?: unknown } }>(
    config,
    "GET",
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=description`,
    undefined,
  );
  return got.fields?.description ?? null;
}

/**
 * 티켓 본문을 바꾼다.
 *
 * 먼저 `notifyUsers=false` 로 보낸다 — 조치 방향은 같은 순간에 **댓글로도** 남으므로
 * (lib/srJiraComment.ts), 알림이 두 번 가면 지켜보는 사람이 같은 소식을 두 번 받는다.
 *
 * 그런데 그 플래그는 **관리자 권한이 있어야** 쓴다. 없으면 Jira 가 400 으로 거절한다.
 * 알림 한 번 더 가는 것 때문에 본문 갱신이 아예 안 되게 두지 않는다 — 400 이면
 * 플래그를 떼고 한 번 더 보낸다(등록 때 칸을 떼고 다시 보내는 것과 같은 방식).
 */
export async function updateIssueDescription(
  config: JiraSrConfig,
  issueKey: string,
  description: unknown,
): Promise<void> {
  const path = `/rest/api/3/issue/${encodeURIComponent(issueKey)}`;
  const body = { fields: { description } };
  try {
    await jfetch(config, "PUT", `${path}?notifyUsers=false`, body);
    return;
  } catch (error) {
    // 400 만 다시 해 본다. 권한·망 문제라면 다시 보내도 같은 답이다.
    if (!(error instanceof AtlassianError) || error.status !== 400) throw error;
  }
  await jfetch(config, "PUT", path, body);
}

export function issueUrl(config: JiraSrConfig, issueKey: string): string {
  return issueKey === "" ? "" : `${config.base}/browse/${issueKey}`;
}

/* ------------------------------------------------------------------ *
 * 필드 수정 (description 말고 일반 칸)
 * ------------------------------------------------------------------ */

/**
 * 이슈의 칸을 바꾼다.
 *
 * `updateIssueDescription` 과 갈라 둔다 — 그쪽은 본문 전용이고 "읽고 나서 쓴다" 는
 * 규칙이 있다(사람이 적어 둔 글을 지우지 않기 위해). 여기는 summary·duedate·assignee
 * 처럼 **우리가 소유하는 칸**만 덮어쓴다.
 *
 * 400 이면 extras 를 떼고 한 번 더 본다(생성과 같은 방식). duedate 가 화면에 없는
 * 프로젝트, assignee 를 못 바꾸는 권한 등에서 400 이 나는데, 그것 때문에 제목 수정이
 * 아예 안 되게 두지 않는다. 뗀 칸 이름을 돌려주므로 부르는 쪽이 사람에게 말할 수 있다.
 *
 * `notifyUsers=false` 를 먼저 쓰는 이유와 그 400 폴백은 updateIssueDescription 과 같다.
 */
export async function updateIssueFields(
  config: JiraSrConfig,
  issueKey: string,
  required: Record<string, unknown>,
  extras: Record<string, unknown> = {},
): Promise<{ dropped: readonly string[] }> {
  const path = `/rest/api/3/issue/${encodeURIComponent(issueKey)}`;

  const send = async (fields: Record<string, unknown>): Promise<void> => {
    try {
      await jfetch(config, "PUT", `${path}?notifyUsers=false`, { fields });
      return;
    } catch (error) {
      // notifyUsers 는 관리자 권한이 필요하다. 없으면 400 — 플래그를 떼고 다시 본다.
      if (!(error instanceof AtlassianError) || error.status !== 400) throw error;
    }
    await jfetch(config, "PUT", path, { fields });
  };

  if (Object.keys(extras).length === 0) {
    await send(required);
    return { dropped: [] };
  }

  try {
    await send({ ...required, ...extras });
    return { dropped: [] };
  } catch (error) {
    if (!(error instanceof AtlassianError) || error.status !== 400) throw error;
    console.error(
      `[jira] ${issueKey} 수정 400 — 곁가지 칸(${Object.keys(extras).join(", ")})을 떼고 다시 시도합니다: ${error.message}`,
    );
    await send(required);
    return { dropped: Object.keys(extras) };
  }
}

/* ------------------------------------------------------------------ *
 * 상태 전이
 * ------------------------------------------------------------------ */

export interface JiraTransition {
  readonly id: string;
  readonly name: string;
  /** 전이 뒤의 상태 이름. 워크플로마다 전이 이름과 상태 이름이 다르다. */
  readonly toStatus: string;
}

/**
 * 지금 그 이슈에서 **할 수 있는** 전이 목록.
 *
 * 전이 id 를 설정으로 박아 둘 수 없어서 매번 묻는다. id 는 프로젝트의 워크플로마다
 * 다르고, 워크플로가 바뀌면 조용히 틀린 상태로 밀어 버린다. 이름으로 고르는 쪽이
 * 느리지만 틀리지 않는다.
 */
export async function listTransitions(
  config: JiraSrConfig,
  issueKey: string,
): Promise<JiraTransition[]> {
  const got = await jfetch<{
    transitions?: Array<{ id?: string; name?: string; to?: { name?: string } }>;
  }>(config, "GET", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, undefined);

  return (got.transitions ?? []).map((t) => ({
    id: String(t.id ?? ""),
    name: String(t.name ?? ""),
    toStatus: String(t.to?.name ?? ""),
  })).filter((t) => t.id !== "");
}

/**
 * 후보 이름 중 **처음 맞는 전이**를 실행한다. 맞는 것이 없으면 아무것도 하지 않고
 * null 을 돌려준다 — 추측해서 엉뚱한 상태로 밀지 않는다.
 *
 * 전이 이름("완료")과 도착 상태 이름("Done")이 다른 워크플로가 흔하므로 둘 다 본다.
 * 비교는 공백을 떼고 소문자로 — "Resolve Issue" 와 "resolve issue" 를 같게 본다.
 */
export async function transitionIssue(
  config: JiraSrConfig,
  issueKey: string,
  candidates: readonly string[],
): Promise<{ applied: JiraTransition | null; available: readonly string[] }> {
  const available = await listTransitions(config, issueKey);
  const norm = (value: string): string => value.replace(/\s+/g, "").toLowerCase();
  const wanted = candidates.map(norm).filter((c) => c !== "");

  const match = available.find(
    (t) => wanted.includes(norm(t.name)) || wanted.includes(norm(t.toStatus)),
  );
  const names = available.map((t) => (t.toStatus === "" ? t.name : `${t.name}→${t.toStatus}`));
  if (match === undefined) return { applied: null, available: names };

  await jfetch(config, "POST", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
    transition: { id: match.id },
  });
  return { applied: match, available: names };
}

/* ------------------------------------------------------------------ *
 * 삭제
 * ------------------------------------------------------------------ */

export type DeleteOutcome = "deleted" | "already_gone" | "forbidden";

/**
 * 이슈를 **지운다. 되돌릴 수 없다.**
 *
 * 부르는 쪽이 사람에게 한 번 더 물었어야 한다(app/api/calendar/route.ts 가 그렇게 한다).
 * 여기서는 결과를 세 가지로 갈라 돌려준다 — 그래야 화면이 사실대로 말할 수 있다.
 *
 *   deleted      지웠다
 *   already_gone 404. **성공으로 본다** — 이미 없는 것이 목표 상태다(멱등).
 *   forbidden    403·405. 지울 권한이 없다. 부르는 쪽이 코멘트로 대신 남긴다.
 *
 * 그 밖의 실패는 던진다. 특히 타임아웃·5xx 는 JiraMaybeCreatedError 로 올라가는데,
 * 삭제에서는 "지워졌는지 모른다" 는 뜻이다. 그 상태를 성공으로 적으면 안 된다.
 *
 * `deleteSubtasks=true`: 하위작업이 있으면 Jira 가 400 으로 거부한다. SR/일정 이슈에
 * 하위작업이 달릴 일은 드물지만, 달려 있다면 그건 우리가 만든 것의 부속이다.
 */
export async function deleteIssue(
  config: JiraSrConfig,
  issueKey: string,
): Promise<DeleteOutcome> {
  const path = `/rest/api/3/issue/${encodeURIComponent(issueKey)}?deleteSubtasks=true`;
  try {
    await jfetch(config, "DELETE", path, undefined);
    return "deleted";
  } catch (error) {
    if (error instanceof AtlassianError) {
      if (error.status === 404) return "already_gone";
      if (error.status === 403 || error.status === 405) return "forbidden";
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * 멱등 — 라벨로 이미 만든 이슈를 찾는다
 * ------------------------------------------------------------------ */

/**
 * 그 라벨이 붙은 이슈 키. 없으면 "".
 *
 * ## 왜 이것이 반드시 필요한가
 *
 * 생성이 타임아웃·5xx 로 실패하면 **만들어졌는지 알 수 없다**(JiraMaybeCreatedError).
 * 그 상태에서 그냥 다시 만들면 같은 일정으로 이슈가 두 개 생긴다. 그래서 생성할 때
 * 일정마다 고유한 라벨을 함께 올리고, 재시도 전에 그 라벨로 **먼저 찾아 입양**한다.
 *
 * 못 찾는 것과 못 물어보는 것을 구분한다: 조회 자체가 실패하면 던진다. ""(없음)으로
 * 뭉개면 "조회 실패 → 없다고 보고 → 두 번째 이슈 생성" 이 된다.
 *
 * 조회 주소는 읽기 쪽(lib/jira.ts)이 쓰는 `/rest/api/3/search/jql` 과 같다 —
 * 이 인스턴스에서 동작이 확인된 주소다.
 */
export async function findIssueByLabel(
  config: JiraSrConfig,
  label: string,
): Promise<string> {
  if (label.trim() === "") return "";
  // 라벨에는 공백이 들어갈 수 없으므로 따옴표만 막으면 JQL 주입 여지가 없다.
  const safe = label.replace(/["\\]/g, "");
  const jql = `labels = "${safe}" ORDER BY created DESC`;
  const path = `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=key&maxResults=1`;

  const got = await jfetch<{ issues?: Array<{ key?: string }> }>(config, "GET", path, undefined);
  return got.issues?.[0]?.key ?? "";
}

