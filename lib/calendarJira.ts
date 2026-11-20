/**
 * 팀 캘린더 일정 → Jira 이슈.
 *
 * ## 규칙 네 줄
 *
 *   1. **일정이 생기면 이슈 하나.** 같은 일정으로 이슈가 두 개 생기지 않는다.
 *   2. **일정을 고치면 이슈도 고친다**(제목·기간·담당자).
 *   3. **상태가 바뀌면 상태 전이**를 한다. 맞는 전이가 없으면 아무것도 하지 않고
 *      그 사실을 일정에 적는다 — 워크플로를 모르면서 추측해 밀지 않는다.
 *   4. **일정을 지우면 이슈도 지운다.** 지울 수 없으면(권한) 코멘트로 대신 남긴다.
 *
 * 3·4번은 사용자가 정한 것이다(docs/plans/team-platform-plan.md S5). 둘 다 되돌릴 수
 * 없는 동작이라, 각 지점에 "무엇을 조심하는가" 를 주석으로 남겼다.
 *
 * ## 멱등성 — 이 파일의 가장 중요한 부분
 *
 * 기존 Jira 쓰기 계층에는 `JiraMaybeCreatedError` 가 있다(타임아웃·망오류·5xx). 그 상태는
 * **이슈가 생겼는지 모른다**. 그냥 재시도하면 같은 일정으로 이슈가 둘 생긴다.
 *
 * 그래서 생성할 때 `SRHUB_EVT_<event_id>` 라벨을 함께 올리고, 재시도 전에 그 라벨로
 * **먼저 찾아 입양**한다(`findIssueByLabel`). `jira_state='unknown'` 은 이 경로로만 풀린다.
 *
 * ## 실패가 캘린더를 막지 않는다
 *
 * 모든 함수는 **결과를 돌려주고 던지지 않는다**(DB 쓰기 실패 같은 극단만 올라간다).
 * Jira 가 꺼져 있거나 죽어 있어도 일정은 등록·수정·삭제된다. 그게 S4 의 인수 조건이다.
 */
import "server-only";
import { adfDoc, adfLines, type AdfDoc } from "./adf.ts";
import { adfLinesWithMentions, type MentionablePerson } from "./adfMention.ts";
import {
  classifyTags,
  corpEpicKey,
  houseSummary,
  readWorkLabel,
  type Corp,
  type Scope,
} from "./jiraHouseStyle.ts";
import { AtlassianError } from "./atlassian.ts";
import { getEvent, type EventState, type JiraState, type TeamEvent } from "./calendar.ts";
import { isoNow } from "./dates.ts";
import type { Db } from "./db.ts";
import {
  JiraMaybeCreatedError,
  addSrComment,
  createIssue,
  deleteIssue,
  findIssueByLabel,
  issueUrl,
  jiraSrConfig,
  transitionIssue,
  updateIssueFields,
  type JiraSrConfig,
} from "./jiraWrite.ts";
import { getUserById, listTeamMembers } from "./users.ts";

/** 여러 줄 글 → ADF 문서. adfDoc + adfLines 를 매번 엮지 않게 묶어 둔다. */
function textDoc(text: string): AdfDoc {
  return adfDoc(adfLines(text));
}

/** 일정 하나를 가리키는 멱등 라벨. Jira 라벨은 공백을 못 쓰므로 밑줄로 잇는다. */
export function eventLabel(eventId: number): string {
  return `SRHUB_EVT_${eventId}`;
}

/** 캘린더 일정으로 만든 이슈를 한꺼번에 찾을 때 쓰는 라벨. */
export const CALENDAR_LABEL = "SRHUB_CAL";

/**
 * 시도 상한. 이 횟수에 닿으면 더 찔러보지 않는다.
 *
 * `sr_jira_links.publish_tries` 와 같은 이유다 — 조건으로 대상을 고르는 구조라서,
 * 영구히 실패하는 건(프로젝트 키가 틀렸다 등)을 매 회차 다시 집어 Jira 를 때린다.
 */
const MAX_TRIES = 5;

/**
 * 시작 날짜 커스텀필드.
 *
 * `customfield_10015` 가 이 인스턴스의 Start date 다(lib/jiraWrite.ts 의 createSrIssue 가
 * 이미 쓰고 있다). 인스턴스마다 다른 값이라 **곁가지 칸**으로 보내고, 400 이면 떨어진다.
 */
const START_DATE_FIELD = "customfield_10015";

export interface JiraSyncResult {
  /** 무엇을 했나. 화면이 그대로 보여 준다. */
  readonly action: "skipped" | "created" | "adopted" | "updated" | "deleted" | "commented" | "failed";
  readonly issueKey: string;
  readonly issueUrl: string;
  readonly state: JiraState;
  /** 사람에게 보여 줄 한 줄. 실패 사유도 여기 담는다. */
  readonly message: string;
  /** 400 폴백으로 떨어진 칸들. 비어 있으면 전부 들어갔다. */
  readonly dropped: readonly string[];
}

function skipped(message: string): JiraSyncResult {
  return { action: "skipped", issueKey: "", issueUrl: "", state: "none", message, dropped: [] };
}

/* ------------------------------------------------------------------ *
 * 상태 ↔ 전이 이름
 * ------------------------------------------------------------------ */

/**
 * 일정 상태를 Jira 전이 이름 후보로 바꾼다.
 *
 * 전이 id 를 설정으로 박을 수 없다 — 워크플로마다 다르고, 바뀌면 조용히 엉뚱한
 * 상태로 밀어 버린다. 그래서 **이름 후보 목록**을 두고 실제 전이 목록과 맞춘다.
 * 환경변수로 늘릴 수 있게 둔다(프로젝트마다 한국어/영어가 섞인다).
 */
export function transitionNames(state: EventState): readonly string[] {
  const extra = (name: string): string[] =>
    (process.env[name] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");

  switch (state) {
    case "doing":
      return [...extra("JIRA_TR_DOING"), "진행 중", "진행중", "In Progress", "Start Progress", "작업 시작"];
    case "done":
      return [...extra("JIRA_TR_DONE"), "완료", "Done", "Resolve Issue", "해결", "Resolved", "Close Issue"];
    case "canceled":
      // 취소 워크플로가 없는 프로젝트가 많다. 완료 쪽으로 떨어지지 **않게** 둔다 —
      // 취소를 완료로 적으면 보고서에서 한 일로 집계된다.
      return [...extra("JIRA_TR_CANCELED"), "취소", "Cancel", "Canceled", "Cancelled", "Won't Do"];
    case "planned":
    default:
      return extra("JIRA_TR_PLANNED");
  }
}

/* ------------------------------------------------------------------ *
 * 필드 만들기
 * ------------------------------------------------------------------ */

async function assigneeAccountId(db: Db, event: TeamEvent): Promise<string> {
  if (event.assigneeUserId === null) return "";
  const user = await getUserById(db, event.assigneeUserId);
  return user?.jiraAccountId ?? "";
}

/** 사람 하나의 보기 이름. 이름이 비면 아이디로 떨어진다(빈칸보다 낫다). */
async function personName(db: Db, userId: number | null): Promise<string> {
  if (userId === null) return "";
  const user = await getUserById(db, userId);
  if (user === null) return "";
  return user.displayName === "" ? user.loginId : user.displayName;
}

/**
 * 이슈 본문에 적을 사람들.
 *
 * ## 등록자를 왜 반드시 적나
 *
 * Jira 의 **reporter 는 공용 Atlassian 계정**이 된다 — 토큰 하나(ATLASSIAN_TOKEN)로
 * 쓰기 때문에 구조상 피할 수 없다. 그래서 본문에 등록자를 적지 않으면 **모든 일정이
 * 같은 사람이 만든 것처럼 보이고**, Jira 쪽에서 "누가 올린 일정인지" 를 알 길이 아예
 * 없다. 캘린더로 돌아오는 링크가 있어도, 목록만 훑는 사람에게는 보이지 않는다.
 *
 * 담당자 이름은 **맞춰진 팀원이 있으면 그 사람의 지금 이름**을 쓰고, 못 맞췄으면
 * 적어 둔 글자(assignee_label)를 쓴다. accountId 가 없어 담당자 칸을 비울 때
 * 본문의 이 줄이 유일한 단서다.
 */
async function peopleOf(
  db: Db,
  event: TeamEvent,
): Promise<{ assigneeName: string; createdByName: string }> {
  const matched = await personName(db, event.assigneeUserId);
  return {
    assigneeName: matched !== "" ? matched : event.assigneeLabel,
    createdByName: await personName(db, event.createdBy),
  };
}

function appUrl(): string {
  return (process.env.SR_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

/** 이슈 본문. 앱으로 돌아오는 링크를 반드시 넣는다 — Jira 에서 본 사람이 원본을 찾게. */
/**
 * 이슈 본문.
 *
 * 사람이 적은 본문(`event.body`)은 **멘션을 살려** 넣는다 — `@민수` 가 글자로 남으면
 * 그 사람에게 알림이 가지 않는다(lib/adfMention.ts 머리말). 우리가 조립하는 아래
 * 정보 줄들은 멘션을 만들지 않는다(담당자 줄은 이름만 적는다 — 담당자 칸이 이미
 * 그 사람을 가리키므로 멘션까지 걸면 같은 사람에게 알림이 두 번 간다).
 */
function describeEvent(
  event: TeamEvent,
  assigneeName: string,
  createdByName: string,
  people: readonly MentionablePerson[] = [],
): { doc: AdfDoc; unlinked: readonly string[] } {
  const period =
    event.endDate === event.startDate
      ? event.startDate
      : `${event.startDate} ~ ${event.endDate}`;
  const time =
    event.startTime === ""
      ? "종일"
      : event.endTime === ""
        ? event.startTime
        : `${event.startTime} ~ ${event.endTime}`;

  const scopes = scopesOf(event);
  const corp = corpOf(event);
  const lines = [
    `기간: ${period} (${time})`,
    `담당: ${assigneeName === "" ? "미지정" : assigneeName}`,
    scopes.length === 0 ? "" : `전산망: ${scopes.join(" / ")}`,
    corp === null ? "" : `법인: ${corp}`,
    event.kind === "" ? "" : `업무: ${event.kind}`,
    // reporter 가 공용 계정이라 이 줄이 "누가 올렸나" 의 유일한 기록이다.
    createdByName === "" ? "" : `등록: ${createdByName} (앱 사용자)`,
    `팀 캘린더: ${appUrl()}/calendar?event=${event.eventId}`,
    "",
    "이 이슈는 팀 캘린더의 일정에서 자동으로 만들어졌습니다. 일정을 고치면 여기도 따라 바뀝니다.",
  ];

  // 사람이 적은 본문이 맨 위에 온다. 멘션은 여기서만 만든다.
  const written = adfLinesWithMentions(event.body.trim(), people);
  const info = textDoc(lines.filter((line) => line !== "").join("\n"));

  return {
    doc: adfDoc([...written.nodes, ...info.content]),
    unlinked: written.unlinked,
  };
}

/**
 * 저장된 망·법인 문자열을 다시 타입으로 읽는다.
 *
 * DB 는 글자로 들고 있고(`scopes='개발/운영'`, `corp='은행'`), 양식 함수는 타입을
 * 받는다. 모르는 값이 섞여 있어도 **버리지 않고 걸러만** 낸다 — 손으로 넣은 값이나
 * 옛 행이 있을 수 있다.
 */
function scopesOf(event: TeamEvent): Scope[] {
  const raw = event.scopes.split("/").map((p) => p.trim()).filter((p) => p !== "");
  return classifyTags(raw).scopes as Scope[];
}

function corpOf(event: TeamEvent): Corp | null {
  return classifyTags(event.corp === "" ? [] : [event.corp]).corp;
}

/**
 * 이슈 제목. **이 팀의 사내 양식**을 따른다 — `[개발/운영] 10월 정기 점검`.
 *
 * 전에는 캘린더의 성격 태그를 대괄호에 넣었다(`[점검] …`). 그 자리는 이 팀에서
 * **전산망**을 적는 자리라(실측 370건), 성격을 넣으면 보고서 집계가 망을 못 읽는다
 * (lib/jira.ts 의 parseCenter). 성격은 라벨로 간다.
 */
function summaryOf(event: TeamEvent): string {
  return houseSummary({ scopes: scopesOf(event), corp: corpOf(event), title: event.title });
}

/** 그 팀에서 멘션할 수 있는 사람들. Jira 계정이 없는 사람도 넣는다(글자로 남긴다). */
async function mentionable(db: Db, teamId: string): Promise<MentionablePerson[]> {
  const members = await listTeamMembers(db, teamId).catch(() => []);
  return members.map((m) => ({
    displayName: m.displayName,
    loginId: m.loginId,
    jiraAccountId: m.jiraAccountId,
  }));
}

/* ------------------------------------------------------------------ *
 * 상태 기록
 * ------------------------------------------------------------------ */

async function writeJiraState(
  db: Db,
  teamId: string,
  eventId: number,
  patch: {
    key?: string;
    url?: string;
    state: JiraState;
    error?: string;
    bumpTries?: boolean;
  },
): Promise<void> {
  await db.run(
    `UPDATE team_events SET
       jira_key = COALESCE(?, jira_key),
       jira_url = COALESCE(?, jira_url),
       jira_state = ?,
       jira_error = ?,
       jira_tries = jira_tries + ?,
       jira_synced_at = ?
     WHERE team_id = ? AND event_id = ?`,
    [
      patch.key ?? null,
      patch.url ?? null,
      patch.state,
      patch.error ?? "",
      patch.bumpTries === true ? 1 : 0,
      isoNow(),
      teamId,
      eventId,
    ],
  );
}

/* ------------------------------------------------------------------ *
 * 생성 · 수정
 * ------------------------------------------------------------------ */

export interface SyncOptions {
  /** 상태가 방금 바뀌었나. 바뀌었을 때만 전이를 시도한다. */
  readonly stateChanged?: boolean;
  /** 상한에 닿은 건도 한 번 더 해 본다(사람이 「다시 시도」를 눌렀을 때). */
  readonly force?: boolean;
}

/**
 * 일정을 Jira 에 반영한다. 이슈가 없으면 만들고, 있으면 고친다.
 *
 * **던지지 않는다.** 실패는 결과로 돌려주고 일정 행에 사유를 남긴다.
 */
export async function syncEventToJira(
  db: Db,
  teamId: string,
  eventId: number,
  options: SyncOptions = {},
): Promise<JiraSyncResult> {
  const config = jiraSrConfig();
  if (config === null) {
    // 기능이 꺼져 있다. 상태를 건드리지 않는다 — "실패" 로 적으면 켰을 때
    // 실패 이력이 남은 것처럼 보인다.
    return skipped("Jira 자동 등록이 꺼져 있습니다(JIRA_AUTO_CREATE).");
  }

  const event = await getEvent(db, teamId, eventId);
  if (event === null) return skipped("그 일정을 찾을 수 없습니다.");

  if (!options.force && event.jiraTries >= MAX_TRIES && event.jiraState !== "ok") {
    return {
      action: "skipped",
      issueKey: event.jiraKey,
      issueUrl: event.jiraUrl,
      state: event.jiraState,
      message: `Jira 반영을 ${MAX_TRIES}번 실패해 멈췄습니다. 설정을 고친 뒤 다시 시도하세요.`,
      dropped: [],
    };
  }

  try {
    // 1. "만들어졌는지 모르는" 상태는 **먼저 찾아 입양**한다. 이 줄이 없으면 이슈가 둘 생긴다.
    let issueKey = event.jiraKey;
    let adopted = false;
    if (issueKey === "" && event.jiraState === "unknown") {
      issueKey = await findIssueByLabel(config, eventLabel(eventId));
      adopted = issueKey !== "";
    }

    if (issueKey === "") {
      return await createForEvent(db, config, teamId, event);
    }
    return await updateForEvent(db, config, teamId, event, issueKey, {
      adopted,
      stateChanged: options.stateChanged === true,
    });
  } catch (error) {
    return await recordFailure(db, teamId, event, error);
  }
}

async function createForEvent(
  db: Db,
  config: JiraSrConfig,
  teamId: string,
  event: TeamEvent,
): Promise<JiraSyncResult> {
  const assignee = await assigneeAccountId(db, event);
  const { assigneeName, createdByName } = await peopleOf(db, event);
  const people = await mentionable(db, teamId);
  const body = describeEvent(event, assigneeName, createdByName, people);
  const corp = corpOf(event);
  const epic = corpEpicKey(corp);

  const required = {
    project: { key: config.projectKey },
    issuetype: { name: config.issueTypeName },
    summary: summaryOf(event),
  };
  // 없어도 이슈가 성립하는 칸. 400 이면 **전부** 떨어진다(생성은 반드시 성공해야 한다).
  const extras: Record<string, unknown> = {
    description: body.doc,
    // 업무 성격은 **사내 라벨**로 간다(TAS_작업지원 248건 등). 앞의 둘은 우리 것이다 —
    // CALENDAR_LABEL 은 캘린더에서 만든 것 전체를 찾는 용도, EVT 라벨은 멱등 키다.
    labels: [CALENDAR_LABEL, eventLabel(event.eventId), readWorkLabel([event.kind])],
    [START_DATE_FIELD]: event.startDate,
    duedate: event.endDate,
  };
  // 상위 에픽이 **법인**을 결정한다(NH은행 운영지원 / NH중앙회 / NH본사 지원).
  // 법인별 설정이 없으면 기존 JIRA_SR_EPIC 으로 떨어지고, 아래에서 그 사실을 적는다.
  if (epic.key !== "") extras["parent"] = { key: epic.key };
  if (config.teamId !== "") extras["customfield_10001"] = config.teamId;
  if (assignee !== "") extras["assignee"] = { accountId: assignee };

  const made = await createIssue(config, required, extras);
  await writeJiraState(db, teamId, event.eventId, {
    key: made.key,
    url: made.url,
    state: "ok",
    error: made.dropped.length === 0 ? "" : `일부 칸이 들어가지 않았습니다: ${made.dropped.join(", ")}`,
  });

  // ⚠ 라벨이 떨어졌으면 **멱등 장치가 없는 이슈**다. 다음 재시도에서 찾을 수 없으므로
  // 그 사실을 분명히 남긴다(사유 칸이 비어 있으면 아무도 모른다).
  const lostLabel = made.dropped.includes("labels");
  const notes: string[] = [
    lostLabel
      ? `이슈 ${made.key} 를 만들었지만 멱등 라벨이 들어가지 않았습니다. 일정을 지울 때 이슈가 함께 지워지지 않을 수 있습니다`
      : `이슈 ${made.key} 를 만들었습니다`,
  ];
  if (corp !== null && !epic.exact) {
    // 조용히 다른 법인 에픽에 달리면 보고서가 그 건을 엉뚱한 법인으로 센다.
    notes.push(
      `법인 ${corp} 의 상위 에픽 설정(JIRA_EPIC_${corp === "은행" ? "BANK" : corp === "중앙회" ? "CENTRAL" : "HQ"})이 없어 기본 에픽에 달았습니다`,
    );
  }
  if (body.unlinked.length > 0) {
    notes.push(`${body.unlinked.join(", ")} 님은 Jira 계정이 연결되지 않아 멘션 대신 글자로 넣었습니다`);
  }
  const message = `${notes.join(". ")}.`;

  return {
    action: "created",
    issueKey: made.key,
    issueUrl: made.url,
    state: "ok",
    message,
    dropped: made.dropped,
  };
}

async function updateForEvent(
  db: Db,
  config: JiraSrConfig,
  teamId: string,
  event: TeamEvent,
  issueKey: string,
  flags: { adopted: boolean; stateChanged: boolean },
): Promise<JiraSyncResult> {
  const assignee = await assigneeAccountId(db, event);

  const required = { summary: summaryOf(event) };
  const extras: Record<string, unknown> = {
    [START_DATE_FIELD]: event.startDate,
    duedate: event.endDate,
  };
  // 담당자를 **비우는 수정**도 보낸다. 담당이 바뀌었는데 Jira 에 옛 사람이 남아 있으면
  // 그 사람이 계속 알림을 받는다. accountId 를 모르는 담당자는 null 로 비운다.
  extras["assignee"] = assignee === "" ? null : { accountId: assignee };

  const { dropped } = await updateIssueFields(config, issueKey, required, extras);

  const url = issueUrl(config, issueKey);
  const notes: string[] = [];
  if (flags.adopted) notes.push("타임아웃으로 만들어졌던 이슈를 되찾아 연결했습니다");
  notes.push(`이슈 ${issueKey} 를 갱신했습니다`);
  if (dropped.length > 0) notes.push(`일부 칸은 들어가지 않았습니다(${dropped.join(", ")})`);

  // 상태 전이. 바뀐 순간에만 한다 — 매 저장마다 전이를 시도하면 이미 완료된 이슈에
  // 같은 전이를 또 보내 워크플로가 거부하고, 그 거부가 "수정 실패" 로 보인다.
  if (flags.stateChanged) {
    const names = transitionNames(event.state);
    if (names.length === 0) {
      notes.push(`상태 '${event.state}' 에 해당하는 전이 이름이 없어 Jira 상태는 그대로입니다`);
    } else {
      const { applied, available } = await transitionIssue(config, issueKey, names);
      if (applied === null) {
        // 추측해서 엉뚱한 상태로 밀지 않는다. 대신 무엇이 가능했는지 적어 준다.
        notes.push(
          `Jira 상태는 바꾸지 못했습니다 — 이 워크플로에 「${names.slice(0, 3).join(", ")}」 전이가 없습니다` +
            (available.length > 0 ? ` (가능한 전이: ${available.join(", ")})` : ""),
        );
      } else {
        notes.push(`Jira 상태를 「${applied.name}」 로 바꿨습니다`);
      }
    }
  }

  await writeJiraState(db, teamId, event.eventId, {
    key: issueKey,
    url,
    state: "ok",
    error: dropped.length === 0 ? "" : `일부 칸이 들어가지 않았습니다: ${dropped.join(", ")}`,
  });

  return {
    action: flags.adopted ? "adopted" : "updated",
    issueKey,
    issueUrl: url,
    state: "ok",
    message: `${notes.join(". ")}.`,
    dropped,
  };
}

/* ------------------------------------------------------------------ *
 * 삭제
 * ------------------------------------------------------------------ */

export interface JiraDeleteResult extends JiraSyncResult {
  /** 이슈가 Jira 에 **남아 있는가**. 화면이 "직접 처리해 주세요" 를 말할 근거다. */
  readonly leftBehind: boolean;
}

/**
 * 일정과 함께 Jira 이슈를 지운다.
 *
 * **지우는 것은 되돌릴 수 없다.** 그래서
 *   - 404 는 성공으로 본다(이미 없는 것이 목표 상태).
 *   - 403·405(권한 없음)면 지우지 않고 **코멘트로 대신** 남긴다. 아무것도 하지 않으면
 *     캘린더에는 없는데 Jira 에는 살아 있는 이슈가 조용히 생긴다.
 *   - 타임아웃·5xx 는 "지워졌는지 모른다" 다. 성공으로 적지 않고 사실대로 돌려준다.
 *
 * 부르는 쪽(app/api/calendar/route.ts)이 **일정을 지우기 전에** 이 함수를 부른다 —
 * 행이 사라지면 이슈 키를 읽을 곳이 없다.
 */
export async function removeEventFromJira(
  db: Db,
  teamId: string,
  eventId: number,
  actor: string,
): Promise<JiraDeleteResult> {
  const config = jiraSrConfig();
  const event = await getEvent(db, teamId, eventId);
  if (event === null) return { ...skipped("그 일정을 찾을 수 없습니다."), leftBehind: false };

  // 키가 없더라도 "만들어졌는지 모르는" 상태면 **찾아 본다.** 안 찾으면 그 이슈가
  // 주인 없이 Jira 에 남는다.
  let issueKey = event.jiraKey;
  if (config !== null && issueKey === "" && event.jiraState === "unknown") {
    issueKey = await findIssueByLabel(config, eventLabel(eventId)).catch(() => "");
  }

  if (issueKey === "") {
    return { ...skipped("연결된 Jira 이슈가 없습니다."), leftBehind: false };
  }
  if (config === null) {
    return {
      action: "skipped",
      issueKey,
      issueUrl: event.jiraUrl,
      state: event.jiraState,
      message: `Jira 자동 등록이 꺼져 있어 이슈 ${issueKey} 는 그대로 남습니다. 직접 처리해 주세요.`,
      dropped: [],
      leftBehind: true,
    };
  }

  const url = issueUrl(config, issueKey);
  try {
    const outcome = await deleteIssue(config, issueKey);
    if (outcome === "deleted" || outcome === "already_gone") {
      return {
        action: "deleted",
        issueKey,
        issueUrl: url,
        state: "none",
        message:
          outcome === "deleted"
            ? `이슈 ${issueKey} 를 지웠습니다.`
            : `이슈 ${issueKey} 는 이미 Jira 에 없었습니다.`,
        dropped: [],
        leftBehind: false,
      };
    }

    // forbidden — 지울 수 없다. 코멘트로 흔적을 남긴다.
    const note = `앱에서 이 일정이 삭제되었습니다${actor === "" ? "" : ` (삭제: ${actor})`}. 이 이슈는 권한이 없어 자동으로 지우지 못했습니다 — 확인 후 처리해 주세요.`;
    await addSrComment(config, issueKey, textDoc(note)).catch(() => undefined);
    return {
      action: "commented",
      issueKey,
      issueUrl: url,
      state: event.jiraState,
      message: `이슈 ${issueKey} 를 지울 권한이 없어 코멘트만 남겼습니다. Jira 에서 직접 처리해 주세요.`,
      dropped: [],
      leftBehind: true,
    };
  } catch (error) {
    const maybe = error instanceof JiraMaybeCreatedError;
    return {
      action: "failed",
      issueKey,
      issueUrl: url,
      state: event.jiraState,
      message: maybe
        ? `이슈 ${issueKey} 가 지워졌는지 확인하지 못했습니다(응답 없음). Jira 에서 확인해 주세요.`
        : `이슈 ${issueKey} 를 지우지 못했습니다: ${errorText(error)}`,
      dropped: [],
      leftBehind: true,
    };
  }
}

/* ------------------------------------------------------------------ *
 * 실패 기록 · 밀린 것 처리
 * ------------------------------------------------------------------ */

function errorText(error: unknown): string {
  if (error instanceof AtlassianError) return `HTTP ${error.status} ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

async function recordFailure(
  db: Db,
  teamId: string,
  event: TeamEvent,
  error: unknown,
): Promise<JiraSyncResult> {
  // **"만들어졌는지 모름" 과 "거절당함" 을 섞지 않는다.** 섞으면 다음 재시도가
  // 라벨 조회를 건너뛰고 이슈를 하나 더 만든다.
  const unknown = error instanceof JiraMaybeCreatedError;
  const state: JiraState = unknown ? "unknown" : "failed";
  const message = unknown
    ? `Jira 응답을 받지 못했습니다. 이슈가 만들어졌는지 확인되지 않아, 다음 시도에서 라벨로 찾아 연결합니다: ${errorText(error)}`
    : `Jira 반영에 실패했습니다: ${errorText(error)}`;

  await writeJiraState(db, teamId, event.eventId, {
    state,
    error: message,
    bumpTries: true,
  });

  return {
    action: "failed",
    issueKey: event.jiraKey,
    issueUrl: event.jiraUrl,
    state,
    message,
    dropped: [],
  };
}

/**
 * 아직 Jira 에 못 올린 일정을 처리한다.
 *
 * ## 누가 깨우나
 *
 * 이 레포에는 Jira 용 워커가 없고, 자동 게시는 **"화면 진입이 엔드포인트를 깨운다"**
 * 로 풀었다(app/closed/AutoPublishKick.tsx — "웹은 스스로 깨어나지 않는다"). 같은
 * 방식을 쓴다: 캘린더 화면에 들어오면 `/api/calendar/jira-sync` 를 한 번 부른다.
 *
 * 멱등하므로 여러 번 깨워도 안전하다. 한 번에 처리하는 건수를 묶어 두는 이유는,
 * 웹 요청 안에서 동기로 Jira 를 호출하기 때문이다(느린 Jira 가 화면을 붙잡지 않게).
 */
export async function syncPendingEvents(
  db: Db,
  teamId: string,
  limit = 5,
): Promise<JiraSyncResult[]> {
  if (jiraSrConfig() === null) return [];

  const rows = await db.all<{ event_id: number }>(
    `SELECT event_id FROM team_events
      WHERE team_id = ?
        AND jira_key = ''
        AND jira_state <> 'ok'
        AND jira_tries < ?
        -- 지난 일정까지 거슬러 올리지 않는다. 기능을 켠 순간 몇 달치가 쏟아지면
        -- 그건 사고다(sr_jira_links 의 "기능 전 SR 은 구조적으로 빠진다" 와 같은 울타리).
        AND end_date >= ?
      ORDER BY event_id ASC
      LIMIT ?`,
    [teamId, MAX_TRIES, todayInKst(), limit],
  );

  const out: JiraSyncResult[] = [];
  for (const row of rows) {
    out.push(await syncEventToJira(db, teamId, Number(row.event_id)));
  }
  return out;
}

/**
 * 오늘(KST). 서버가 UTC 일 수 있어 보정한다 —
 * lib/jiraWrite.ts 의 today() 와 같은 이유다.
 */
function todayInKst(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
