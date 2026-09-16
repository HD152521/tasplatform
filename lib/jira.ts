/**
 * 정기점검 보고서 "3-3 작업 진행 현황" 을 Jira 에서 만든다.
 *
 * 읽기만 한다 (lib/atlassian.ts 참고).
 *
 * 실제 8월 보고서와 대조해 확정한 규칙:
 *   전산센터 = 제목 앞 대괄호      "[개발]Internal 통신 지연" → 개발
 *   법인     = 상위 에픽 이름       "NH은행 운영지원" → 은행 / "NH중앙회 운영지원" → 중앙회
 *              "NH본사 지원" 은 보고서에 넣지 않는다.
 *   작업일   = 생성일 ~ 종료일      같은 날이면 한 날짜로 접는다.
 *   합치기   = 법인과 작업 내역이 같으면 한 줄. 전산센터는 "운영,DR" 로 모으고
 *              작업일은 포괄 범위로 넓힌다 (1~3 과 2~4 → 1~4).
 *   지원유형 = 늘 "방문"
 *   이슈사항 = 늘 "특이사항 없음"
 *   비고     = 이슈 상태. 완료·해결됨은 모두 "완료" 로 적는다.
 *
 * SR 은 별도 섹션(2-2)에서 다루므로 "SR오픈" 타입은 뺀다.
 */
import "server-only";
import { get, type AtlassianConfig } from "./atlassian.ts";
import {
  dateOf, isHeadOffice, mergeKey, mergeRows, parseCenter, spanLabel, workStatusLabel,
  type Mergeable,
} from "./jiraFormat.ts";

export type Corp = "은행" | "중앙회";

export interface WorkRow {
  key: string;
  url: string;
  /** 전산센터. 제목에 대괄호가 없으면 빈 문자열. */
  center: string;
  corp: Corp;
  /** "08/03 – 08/14" 또는 "08/03". 미종료면 "08/03 –". */
  span: string;
  title: string;
  /** 늘 "방문" */
  support: string;
  /** 늘 "특이사항 없음" */
  issue: string;
  /** 이슈 상태 그대로. 합쳐진 줄은 대표 상태 하나. */
  note: string;
  /** 합쳐진 이슈 키들. 한 건이면 자기 자신만. */
  keys: string[];
  /** 몇 건이 합쳐졌는지. 1 이면 합쳐지지 않은 것. */
  merged: number;
}

/** 보고서에서 뺀 이슈. 왜 빠졌는지 화면에 보여주려고 남긴다. */
export interface SkippedRow {
  key: string;
  title: string;
  reason: string;
}

export interface WorkResult {
  rows: WorkRow[];
  skipped: SkippedRow[];
  /** 조회한 전체 건수 (제외 전). */
  scanned: number;
}

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    created: string;
    resolutiondate: string | null;
    status: { name: string };
    parent?: { key: string; fields: { summary: string } };
  };
}

interface SearchResponse {
  issues?: JiraIssue[];
  nextPageToken?: string;
}

const FIELDS = "summary,created,resolutiondate,status,parent";

/** 'YYYY-MM' 의 다음 달. JQL 상한으로 쓴다. */
function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** 이름에서 법인을 읽는다. 중앙회를 먼저 봐야 한다 — "NH중앙회" 에도 "NH" 가 있다. */
export function readCorp(name: string): Corp | "본사" | null {
  if (name.includes("중앙회")) return "중앙회";
  if (name.includes("본사")) return "본사";
  if (name.includes("은행")) return "은행";
  return null;
}

async function searchAll(
  config: AtlassianConfig,
  jql: string,
  fields: string,
): Promise<JiraIssue[]> {
  const out: JiraIssue[] = [];
  let token: string | undefined;
  // 한 달치라 몇 페이지면 끝난다. 그래도 무한루프는 막는다.
  for (let page = 0; page < 20; page += 1) {
    const params: Record<string, string> = { jql, fields, maxResults: "100" };
    if (token !== undefined) params["nextPageToken"] = token;
    const body = await get<SearchResponse>(config, "/rest/api/3/search/jql", params);
    out.push(...(body.issues ?? []));
    if (body.nextPageToken === undefined) break;
    token = body.nextPageToken;
  }
  return out;
}

/**
 * 상위를 따라 올라가며 법인을 찾는다.
 *
 * 계층이 에픽 → 작업 → 하위작업이라 바로 위 부모가 에픽이 아닐 수 있다.
 * 한 번에 안 나오면 부모들을 모아 한 번 더 조회한다 (건별 조회는 요청이 너무 많다).
 */
async function resolveCorps(
  config: AtlassianConfig,
  issues: JiraIssue[],
): Promise<Map<string, Corp | "본사" | null>> {
  const found = new Map<string, Corp | "본사" | null>();
  const pending = new Map<string, string>(); // 이슈키 → 아직 못 푼 부모키

  for (const issue of issues) {
    const parent = issue.fields.parent;
    if (parent === undefined) {
      found.set(issue.key, null);
      continue;
    }
    const corp = readCorp(parent.fields.summary);
    if (corp !== null) found.set(issue.key, corp);
    else pending.set(issue.key, parent.key);
  }

  // 부모의 부모를 세 단계까지 따라간다.
  for (let depth = 0; depth < 3 && pending.size > 0; depth += 1) {
    const keys = [...new Set(pending.values())];
    const parents = await searchAll(
      config,
      `key in (${keys.map((k) => `"${k}"`).join(",")})`,
      FIELDS,
    );
    const byKey = new Map(parents.map((p) => [p.key, p]));

    for (const [issueKey, parentKey] of [...pending]) {
      const parent = byKey.get(parentKey);
      if (parent === undefined) {
        found.set(issueKey, null);
        pending.delete(issueKey);
        continue;
      }
      const own = readCorp(parent.fields.summary);
      if (own !== null) {
        found.set(issueKey, own);
        pending.delete(issueKey);
        continue;
      }
      const grand = parent.fields.parent;
      if (grand === undefined) {
        found.set(issueKey, null);
        pending.delete(issueKey);
        continue;
      }
      const fromGrand = readCorp(grand.fields.summary);
      if (fromGrand !== null) {
        found.set(issueKey, fromGrand);
        pending.delete(issueKey);
      } else {
        pending.set(issueKey, grand.key);
      }
    }
  }

  for (const issueKey of pending.keys()) found.set(issueKey, null);
  return found;
}

/** 해당 월의 작업 진행 현황을 만든다. month 는 'YYYY-MM'. */
export async function fetchMonthlyWork(
  config: AtlassianConfig,
  month: string,
): Promise<WorkResult> {
  const jql = [
    `project = "${config.jiraProject}"`,
    `issuetype != "SR오픈"`,
    `created >= "${month}-01"`,
    `created < "${nextMonth(month)}-01"`,
    "ORDER BY created ASC",
  ].join(" AND ").replace(" AND ORDER BY", " ORDER BY");

  const issues = await searchAll(config, jql, FIELDS);
  const corps = await resolveCorps(config, issues);

  interface Draft extends Mergeable {
    key: string;
    url: string;
    support: string;
    issue: string;
    note: string;
  }
  const drafts: Draft[] = [];
  const skipped: SkippedRow[] = [];

  for (const issue of issues) {
    const corp = corps.get(issue.key) ?? null;
    const { center, title } = parseCenter(issue.fields.summary);

    // 제목을 먼저 본다. 상위 에픽만 보면 "[본사]" 인데 상위가 은행 쪽인 건을 놓친다.
    if (isHeadOffice(center) || corp === "본사") {
      skipped.push({ key: issue.key, title, reason: "본사 업무" });
      continue;
    }
    if (corp === null) {
      skipped.push({ key: issue.key, title, reason: "법인을 찾지 못함 (상위 없음)" });
      continue;
    }

    drafts.push({
      key: issue.key,
      url: `${config.base}/browse/${issue.key}`,
      center,
      corp,
      title,
      startDate: dateOf(issue.fields.created) ?? "",
      endDate: dateOf(issue.fields.resolutiondate),
      support: "방문",
      issue: "특이사항 없음",
      note: workStatusLabel(issue.fields.status.name),
    });
  }

  // 같은 법인·같은 작업 내역이면 한 줄로 합친다.
  const rows: WorkRow[] = mergeRows(drafts).map((row) => ({
    key: row.key,
    url: row.url,
    center: row.center,
    corp: row.corp as Corp,
    span: spanLabel(row.startDate, row.endDate),
    title: row.title,
    support: row.support,
    issue: row.issue,
    note: row.note,
    keys: drafts.filter((d) => mergeKey(d) === mergeKey(row)).map((d) => d.key),
    merged: row.merged,
  }));

  return { rows, skipped, scanned: issues.length };
}
