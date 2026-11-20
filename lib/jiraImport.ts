/**
 * Jira → 팀 캘린더 가져오기(백필).
 *
 * 캘린더는 "앞으로 할 일" 만 담고 있었다. 그런데 **이미 Jira 에 쌓인 작업**이 그 팀의
 * 실제 이력이다 — 그걸 안 가져오면 캘린더가 빈 채로 시작하고, 사람별 집계도 이번 주
 * 것밖에 없다. 그래서 한 번 긁어 온다.
 *
 * ## 시작점을 설정으로 둔다
 *
 * 기본은 **이번 달 1일**이다. 더 거슬러 올라가면 몇 년치가 한꺼번에 들어와 달력이
 * 과거로 가득 찬다(그리고 그 대부분은 이미 끝난 일이라 볼 이유가 없다). 사용자가
 * 정한 시작점은 2026-11-01 이고, `JIRA_IMPORT_FROM` 으로 바꾼다.
 *
 * ## 같은 이슈가 두 번 들어오지 않는다
 *
 * `team_events.jira_key` 로 맞춘다. 이미 있는 키면 **갱신**하고, 없으면 새로 넣는다.
 * 캘린더에서 만든 이슈에는 `SRHUB_EVT_<id>` 라벨이 있지만 Jira 에서 사람이 만든
 * 이슈에는 없다 — 그래서 라벨이 아니라 키로 맞춘다.
 *
 * ## 가져온 일정을 Jira 로 되밀지 않는다
 *
 * 들어온 행은 `jira_state='ok'` + `jira_key` 가 채워진 상태다. 그래서 다음 동기화가
 * "만들기" 가 아니라 "고치기" 로 간다. 가져오기 직후 곧바로 되밀면 사람이 Jira 에
 * 적어 둔 제목·기한을 우리 형식으로 덮어쓸 수 있으므로, **가져오기는 읽기만 한다.**
 *
 * server-only 가 붙는다 — Jira 읽기 계층(lib/atlassian.ts)이 그렇다.
 */
import "server-only";
import { get, atlassianConfig, type AtlassianConfig } from "./atlassian.ts";
import { assertValidTeamId } from "./config.ts";
import { isoNow } from "./dates.ts";
import type { Db } from "./db.ts";
import { isHeadOffice, parseCenter } from "./jiraFormat.ts";
import { classifyTags, type Corp } from "./jiraHouseStyle.ts";
import { readCorp } from "./jira.ts";
import { isDateString } from "./quickAdd.ts";
import { listTeamMembers } from "./users.ts";
import type { EventState } from "./calendar.ts";

/** 이 인스턴스의 Start date 커스텀필드(lib/jiraWrite.ts 와 같은 값). */
const START_DATE_FIELD = "customfield_10015";

const FIELDS = [
  "summary",
  "status",
  "created",
  "duedate",
  "resolutiondate",
  "assignee",
  "labels",
  "issuetype",
  "parent",
  START_DATE_FIELD,
].join(",");

interface JiraIssue {
  key: string;
  fields: {
    summary?: string;
    status?: { name?: string };
    created?: string;
    duedate?: string | null;
    resolutiondate?: string | null;
    assignee?: { accountId?: string; displayName?: string } | null;
    labels?: string[];
    issuetype?: { name?: string };
    parent?: { key?: string; fields?: { summary?: string } };
    [key: string]: unknown;
  };
}

interface SearchResponse {
  issues?: JiraIssue[];
  nextPageToken?: string;
}

/** 가져오기 시작 날짜. 기본은 이번 달 1일(KST). */
export function importFrom(): string {
  const configured = (process.env.JIRA_IMPORT_FROM ?? "").trim();
  if (isDateString(configured)) return configured;
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return `${kst.slice(0, 7)}-01`;
}

/**
 * Jira 상태 → 일정 상태.
 *
 * 실측 분포: 완료 309 · 해결됨 29 · 해야 할 일 19 · 진행 중 13.
 * 모르는 상태는 **예정**으로 둔다 — 완료로 보면 안 한 일이 한 일로 집계된다.
 */
export function stateFromStatus(status: string): EventState {
  const s = status.trim().toLowerCase().replace(/\s+/g, "");
  if (["완료", "해결됨", "done", "resolved", "closed"].includes(s)) return "done";
  if (["진행중", "inprogress", "inreview"].includes(s)) return "doing";
  if (["취소", "canceled", "cancelled", "wontdo"].includes(s)) return "canceled";
  return "planned";
}

/** ISO 타임스탬프 → 'YYYY-MM-DD'. Jira 는 +0900 을 붙여 주므로 글자만 자른다. */
function dateOnly(value: string | null | undefined): string {
  if (typeof value !== "string" || value.length < 10) return "";
  const head = value.slice(0, 10);
  return isDateString(head) ? head : "";
}

export interface ImportedEvent {
  readonly issueKey: string;
  readonly title: string;
  readonly scopes: string;
  readonly corp: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly state: EventState;
  readonly assigneeAccountId: string;
  readonly assigneeLabel: string;
  readonly kind: string;
}

/**
 * 이슈 하나 → 일정 하나. **순수 함수**라 시험으로 잠근다.
 *
 * 매핑 근거(실측 370건, lib/jiraHouseStyle.ts 머리말):
 *   제목 앞 대괄호 → 전산망(scopes). lib/jiraFormat.ts 의 parseCenter 를 그대로 쓴다.
 *   상위 에픽 이름 → 법인(corp). lib/jira.ts 의 readCorp 를 그대로 쓴다.
 *   시작일 → Start date 커스텀필드, 없으면 생성일.
 *   종료일 → duedate, 없으면 해결일, 없으면 시작일.
 *
 * 날짜가 뒤집힌 이슈가 실제로 있다(해결일이 시작일보다 앞). 그때는 시작일로 접는다 —
 * 저장 계층이 거절하기 때문이고(lib/calendar.ts validate), 거절되면 그 건만 조용히
 * 빠진다.
 */
export function mapIssue(issue: JiraIssue): ImportedEvent | null {
  const summary = (issue.fields.summary ?? "").trim();
  if (summary === "") return null;

  const { center, title } = parseCenter(summary);
  const scopes = classifyTags(center.split("/").map((p) => p.trim()).filter((p) => p !== ""));

  // 법인: 제목이 본사라고 말하면 본사다(lib/jiraFormat.ts isHeadOffice 의 근거와 같다).
  // 아니면 상위 에픽 이름에서 읽는다.
  const fromParent = readCorp(issue.fields.parent?.fields?.summary ?? "");
  const corp: Corp | null = isHeadOffice(center)
    ? "본사"
    : fromParent === "본사"
      ? "본사"
      : fromParent === null
        ? scopes.corp
        : fromParent;

  const start = dateOnly(issue.fields[START_DATE_FIELD] as string | undefined) || dateOnly(issue.fields.created);
  if (start === "") return null;

  const endRaw = dateOnly(issue.fields.duedate) || dateOnly(issue.fields.resolutiondate) || start;
  const end = endRaw < start ? start : endRaw;

  // 업무 성격: 라벨에서 읽는다. TAS_ 접두를 떼고 사람이 읽는 말로 둔다.
  const labels = issue.fields.labels ?? [];
  const kind = labels.includes("TAS_장애대응")
    ? "장애"
    : labels.includes("TAS_내부업무")
      ? "내부"
      : "";

  return {
    issueKey: issue.key,
    title: title === "" ? summary : title,
    scopes: scopes.scopes.join("/"),
    corp: corp ?? "",
    startDate: start,
    endDate: end,
    state: stateFromStatus(issue.fields.status?.name ?? ""),
    assigneeAccountId: issue.fields.assignee?.accountId ?? "",
    assigneeLabel: issue.fields.assignee?.displayName ?? "",
    kind,
  };
}

/**
 * 가져오지 않을 이슈인가.
 *
 *   - 에픽: 일정이 아니라 묶음이다.
 *   - SR오픈 / TAS_SR: SR 은 이 도구의 다른 화면이 이미 다룬다(진행중·종료 목록).
 *     캘린더에 또 넣으면 같은 일이 두 곳에 보인다.
 *   - 캘린더가 만든 이슈: 이미 그 일정이 있다(라벨로 안다).
 */
export function skipReason(issue: JiraIssue): string | null {
  const type = issue.fields.issuetype?.name ?? "";
  if (type === "에픽" || type.toLowerCase() === "epic") return "에픽";
  if (type === "SR오픈") return "SR";
  const labels = issue.fields.labels ?? [];
  if (labels.includes("TAS_SR")) return "SR";
  if (labels.includes("SRHUB_CAL")) return "캘린더가 만든 것";
  return null;
}

export interface ImportResult {
  readonly scanned: number;
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly from: string;
  /** 담당자를 팀원과 못 맞춘 이슈 수. 화면이 "Jira 계정 연결" 을 권하는 근거다. */
  readonly unmatchedAssignee: number;
  readonly message: string;
}

async function searchAll(config: AtlassianConfig, jql: string): Promise<JiraIssue[]> {
  const out: JiraIssue[] = [];
  let token: string | undefined;
  // 한 번에 1000건까지. 그 이상이면 시작점을 늦추는 쪽이 맞다.
  for (let page = 0; page < 10; page += 1) {
    const params: Record<string, string> = { jql, fields: FIELDS, maxResults: "100" };
    if (token !== undefined) params["nextPageToken"] = token;
    const body = await get<SearchResponse>(config, "/rest/api/3/search/jql", params);
    out.push(...(body.issues ?? []));
    if (body.nextPageToken === undefined) break;
    token = body.nextPageToken;
  }
  return out;
}

/**
 * Jira 의 작업을 캘린더로 가져온다. **읽기만** 한다(Jira 에 쓰지 않는다).
 *
 * 같은 이슈를 다시 가져오면 갱신된다 — 여러 번 눌러도 중복되지 않는다.
 */
export async function importFromJira(
  db: Db,
  teamId: string,
  options: { from?: string; actor?: string } = {},
): Promise<ImportResult> {
  assertValidTeamId(teamId);

  const config = atlassianConfig();
  const project = (process.env.JIRA_SR_PROJECT ?? process.env.JIRA_PROJECT ?? "").trim();
  if (config === null || project === "") {
    return {
      scanned: 0, created: 0, updated: 0, skipped: 0, unmatchedAssignee: 0,
      from: options.from ?? importFrom(),
      message: "Jira 설정(ATLASSIAN_* · JIRA_SR_PROJECT)이 없어 가져올 수 없습니다.",
    };
  }

  const from = isDateString(options.from ?? "") ? (options.from as string) : importFrom();

  // 시작일(커스텀필드)이 그 날 이후이거나, 시작일이 비어 있고 **생성일**이 그 날 이후인 것.
  // 둘을 OR 로 묶는 이유: Start date 를 안 적은 이슈가 섞여 있다.
  const jql =
    `project = ${project} AND (` +
    `"Start date" >= "${from}" OR (` +
    `"Start date" IS EMPTY AND created >= "${from}")) ` +
    `ORDER BY created ASC`;

  let issues: JiraIssue[];
  try {
    issues = await searchAll(config, jql);
  } catch (error) {
    // Start date 필드 이름이 인스턴스마다 달라 JQL 이 거부될 수 있다. 그때는
    // 생성일만으로 다시 묻는다 — 적게 가져오는 것이 아예 못 가져오는 것보다 낫다.
    const fallback = `project = ${project} AND created >= "${from}" ORDER BY created ASC`;
    try {
      issues = await searchAll(config, fallback);
    } catch (second) {
      return {
        scanned: 0, created: 0, updated: 0, skipped: 0, unmatchedAssignee: 0, from,
        message: `Jira 조회에 실패했습니다: ${second instanceof Error ? second.message : String(second)} (처음 시도: ${error instanceof Error ? error.message : String(error)})`,
      };
    }
  }

  const members = await listTeamMembers(db, teamId);
  const byAccount = new Map(
    members.filter((m) => m.jiraAccountId !== "").map((m) => [m.jiraAccountId, m]),
  );

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let unmatched = 0;
  const now = isoNow();

  for (const issue of issues) {
    if (skipReason(issue) !== null) {
      skipped += 1;
      continue;
    }
    const mapped = mapIssue(issue);
    if (mapped === null) {
      skipped += 1;
      continue;
    }

    const member = mapped.assigneeAccountId === "" ? undefined : byAccount.get(mapped.assigneeAccountId);
    if (mapped.assigneeAccountId !== "" && member === undefined) unmatched += 1;

    const existing = await db.get<{ event_id: number }>(
      "SELECT event_id FROM team_events WHERE team_id = ? AND jira_key = ?",
      [teamId, mapped.issueKey],
    );

    if (existing === undefined) {
      await db.run(
        `INSERT INTO team_events (
           team_id, title, body, kind, scopes, corp,
           start_date, end_date, start_time, end_time,
           assignee_user_id, assignee_label, state, created_by, created_at, updated_at,
           jira_key, jira_url, jira_state, jira_error, jira_tries, jira_synced_at
         ) VALUES (?,?,'',?,?,?,?,?,'','',?,?,?,NULL,?,?,?,?,'ok','',0,?)`,
        [
          teamId, mapped.title, mapped.kind, mapped.scopes, mapped.corp,
          mapped.startDate, mapped.endDate,
          member?.userId ?? null, mapped.assigneeLabel, mapped.state,
          now, now,
          mapped.issueKey, `${config.base}/browse/${mapped.issueKey}`, now,
        ],
      );
      created += 1;
    } else {
      // 이미 있는 건은 **Jira 가 정본**이다(가져오기니까). 사람이 앱에서 적어 둔
      // 본문·메모는 건드리지 않는다 — 그건 Jira 에 없는 값이다.
      await db.run(
        `UPDATE team_events SET
           title = ?, kind = ?, scopes = ?, corp = ?,
           start_date = ?, end_date = ?,
           assignee_user_id = ?, assignee_label = ?, state = ?,
           jira_url = ?, jira_state = 'ok', jira_error = '', jira_synced_at = ?, updated_at = ?
         WHERE team_id = ? AND event_id = ?`,
        [
          mapped.title, mapped.kind, mapped.scopes, mapped.corp,
          mapped.startDate, mapped.endDate,
          member?.userId ?? null, mapped.assigneeLabel, mapped.state,
          `${config.base}/browse/${mapped.issueKey}`, now, now,
          teamId, Number(existing.event_id),
        ],
      );
      updated += 1;
    }
  }

  const notes = [`${from} 이후 ${issues.length}건을 훑어 ${created}건 추가·${updated}건 갱신했습니다`];
  if (skipped > 0) notes.push(`${skipped}건은 건너뜀(에픽·SR·캘린더가 만든 것)`);
  if (unmatched > 0) {
    notes.push(
      `${unmatched}건은 Jira 담당자를 팀원과 맞추지 못했습니다 — 각자 「내 설정」에서 Jira 계정 id 를 넣으면 다음 가져오기에서 연결됩니다`,
    );
  }

  return {
    scanned: issues.length,
    created,
    updated,
    skipped,
    unmatchedAssignee: unmatched,
    from,
    message: `${notes.join(". ")}.`,
  };
}
