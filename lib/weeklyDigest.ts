/**
 * 주간 자동 정리 — "누가 무엇을 했는지" 를 모아 한 장으로.
 *
 * 재료는 그 주의 일정(`team_events`)과 메모(`event_notes`)다. 사람이 캘린더에 적어
 * 두기만 하면 금요일에 정리가 나오는 것이 목표다.
 *
 * ## 반드시 지키는 두 가지
 *
 *   1. **LLM 이 없거나 실패해도 정리는 나온다.** 규칙 기반 집계로 떨어진다.
 *      이 레포의 기존 철학과 같다 — 요약이 실패해도 알림 자체는 반드시 나간다
 *      (lib/notify.ts·lib/summary.ts 가 그렇게 돼 있다). 정리가 "LLM 이 죽으면
 *      아무것도 없음" 이 되면 아무도 이 기능을 믿지 않는다.
 *   2. **같은 주를 다시 만들어도 쌓이지 않는다.** `(team_id, week)` 한 행을 덮어쓴다.
 *
 * ## 순수 함수를 떼어 둔다
 *
 * `weekMondayOf`·`weekRange`·`ruleBasedDigest` 는 DB·LLM 을 모르는 순수 함수다.
 * 집계가 틀리는 것은 조용한 실패(숫자가 그럴듯하게 틀린다)라서 단위 시험으로 잠근다.
 */
import { getAppState, setAppState } from "./appState.ts";
import { assertValidTeamId } from "./config.ts";
import { addDays } from "./quickAdd.ts";
import { describeWeek, recentWeeks, weekMondayOf, weekRange, weeksAgo } from "./weekRange.ts";
import { isoNow } from "./dates.ts";
import type { Db } from "./db.ts";
import { listEventsBetween, type EventState, type TeamEventView } from "./calendar.ts";

/**
 * 주 경계 계산은 `lib/weekRange.ts` 에 있다 — **순수 함수만 모아 둔 파일**이다.
 * 화면(클라이언트)이 주 목록을 그리려면 그 함수가 필요한데, 이 파일에서 가져가면
 * `pg` 가 브라우저 번들로 따라 들어가 빌드가 깨진다. 서버 쪽 편의를 위해 여기서
 * 그대로 다시 내보낸다.
 */
export { describeWeek, recentWeeks, weekMondayOf, weekRange, weeksAgo };

/** 어느 LLM 으로도 만들지 못했을 때의 표시. 화면이 그대로 보여 준다. */
export type DigestSource = "llm" | "rule";

export interface WeeklyDigest {
  readonly teamId: string;
  /** 그 주 월요일의 'YYYY-MM-DD'. */
  readonly week: string;
  readonly body: string;
  readonly source: DigestSource;
  readonly createdAt: string;
  readonly createdBy: string;
}

/* ------------------------------------------------------------------ *
 * 재료
 * ------------------------------------------------------------------ */

export interface DigestNote {
  readonly eventId: number;
  readonly author: string;
  readonly body: string;
}

export interface DigestInput {
  readonly week: string;
  readonly from: string;
  readonly to: string;
  readonly events: readonly TeamEventView[];
  readonly notes: readonly DigestNote[];
}

/** 그 주의 일정과 메모를 모은다. */
export async function collectDigestInput(
  db: Db,
  teamId: string,
  week: string,
): Promise<DigestInput> {
  assertValidTeamId(teamId);
  const { from, to } = weekRange(week);
  const events = await listEventsBetween(db, teamId, from, to);

  let notes: DigestNote[] = [];
  if (events.length > 0) {
    const holes = events.map(() => "?").join(",");
    const rows = await db.all<{ event_id: number; author: string; body: string }>(
      `SELECT event_id, author, body FROM event_notes
        WHERE event_id IN (${holes}) ORDER BY note_id ASC`,
      events.map((e) => e.eventId),
    );
    notes = rows.map((row) => ({
      eventId: Number(row.event_id),
      author: row.author,
      body: row.body,
    }));
  }

  return { week: weekMondayOf(week), from, to, events, notes };
}

/* ------------------------------------------------------------------ *
 * 규칙 기반 정리 — LLM 이 없어도 이게 나온다
 * ------------------------------------------------------------------ */

const STATE_LABEL: Record<EventState, string> = {
  planned: "예정",
  doing: "진행",
  done: "완료",
  canceled: "취소",
};

function personOf(event: TeamEventView): string {
  if (event.assigneeName !== "") return event.assigneeName;
  if (event.assigneeLabel !== "") return event.assigneeLabel;
  return "담당 미지정";
}

function periodOf(event: TeamEventView): string {
  const short = (date: string): string =>
    `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
  const days = event.endDate === event.startDate ? short(event.startDate) : `${short(event.startDate)}~${short(event.endDate)}`;
  if (event.startTime === "") return days;
  return `${days} ${event.startTime}${event.endTime === "" ? "" : `-${event.endTime}`}`;
}

/**
 * 집계와 사람별 목록. **순수 함수** — 같은 입력이면 같은 글이 나온다.
 *
 * LLM 이 다듬은 글의 **재료**로도 쓴다. 그래야 LLM 이 없을 때와 있을 때의 내용이
 * 같은 사실 위에 서고, 숫자가 어긋나지 않는다.
 */
export function ruleBasedDigest(input: DigestInput): string {
  const lines: string[] = [];
  lines.push(`# 주간 정리 ${describeWeek(input.week)}`);
  lines.push("");

  if (input.events.length === 0) {
    lines.push("이번 주에 등록된 일정이 없습니다.");
    return lines.join("\n");
  }

  // ── 집계 ──
  const byState = new Map<EventState, number>();
  const byKind = new Map<string, number>();
  for (const event of input.events) {
    byState.set(event.state, (byState.get(event.state) ?? 0) + 1);
    const kind = event.kind === "" ? "기타" : event.kind;
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  }

  const stateText = (["done", "doing", "planned", "canceled"] as EventState[])
    .filter((s) => (byState.get(s) ?? 0) > 0)
    .map((s) => `${STATE_LABEL[s]} ${byState.get(s)}`)
    .join(" · ");
  const kindText = [...byKind.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, n]) => `${kind} ${n}`)
    .join(" · ");

  lines.push(`## 한눈에`);
  lines.push(`- 일정 ${input.events.length}건 — ${stateText}`);
  lines.push(`- 종류 — ${kindText}`);
  if (input.notes.length > 0) lines.push(`- 작업 메모 ${input.notes.length}건`);
  lines.push("");

  // ── 사람별 ──
  const notesByEvent = new Map<number, DigestNote[]>();
  for (const note of input.notes) {
    const bucket = notesByEvent.get(note.eventId);
    if (bucket === undefined) notesByEvent.set(note.eventId, [note]);
    else bucket.push(note);
  }

  const byPerson = new Map<string, TeamEventView[]>();
  for (const event of input.events) {
    const person = personOf(event);
    const bucket = byPerson.get(person);
    if (bucket === undefined) byPerson.set(person, [event]);
    else bucket.push(event);
  }

  lines.push(`## 사람별`);
  // 담당 미지정은 **맨 뒤**로. 사람 이름 사이에 섞이면 목록이 읽히지 않는다.
  const people = [...byPerson.keys()].sort((a, b) => {
    if (a === "담당 미지정") return 1;
    if (b === "담당 미지정") return -1;
    return a.localeCompare(b, "ko");
  });

  for (const person of people) {
    const events = byPerson.get(person) ?? [];
    lines.push("");
    lines.push(`### ${person} (${events.length}건)`);
    for (const event of events) {
      const kind = event.kind === "" ? "" : `[${event.kind}] `;
      lines.push(`- ${periodOf(event)} ${kind}${event.title} — ${STATE_LABEL[event.state]}`);
      for (const note of notesByEvent.get(event.eventId) ?? []) {
        // 메모 작성자가 담당자와 다를 수 있다. 다를 때만 이름을 붙인다.
        const who = note.author === person || note.author === "" ? "" : `${note.author}: `;
        lines.push(`  - ${who}${note.body.replace(/\s*\n\s*/g, " ")}`);
      }
    }
  }

  // ── 미완료 이월 ──
  const carry = input.events.filter((e) => e.state === "planned" || e.state === "doing");
  if (carry.length > 0) {
    lines.push("");
    lines.push(`## 다음 주로 넘어가는 것 (${carry.length}건)`);
    for (const event of carry) {
      lines.push(`- ${periodOf(event)} ${event.title} — ${personOf(event)} · ${STATE_LABEL[event.state]}`);
    }
  }

  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * 저장 · 조회
 * ------------------------------------------------------------------ */

interface DigestRowRaw {
  team_id: string;
  week: string;
  body: string;
  source: string;
  created_at: string;
  created_by: string;
}

function toDigest(row: DigestRowRaw): WeeklyDigest {
  return {
    teamId: row.team_id,
    week: row.week,
    body: row.body,
    source: row.source === "llm" ? "llm" : "rule",
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

export async function getWeeklyDigest(
  db: Db,
  teamId: string,
  week: string,
): Promise<WeeklyDigest | null> {
  const row = await db.get<DigestRowRaw>(
    "SELECT * FROM weekly_digests WHERE team_id = ? AND week = ?",
    [teamId, weekMondayOf(week)],
  );
  return row === undefined ? null : toDigest(row);
}

export async function listWeeklyDigests(
  db: Db,
  teamId: string,
  limit = 12,
): Promise<WeeklyDigest[]> {
  const rows = await db.all<DigestRowRaw>(
    "SELECT * FROM weekly_digests WHERE team_id = ? ORDER BY week DESC LIMIT ?",
    [teamId, limit],
  );
  return rows.map(toDigest);
}

async function saveDigest(
  db: Db,
  digest: Omit<WeeklyDigest, "createdAt">,
): Promise<WeeklyDigest> {
  const now = isoNow();
  await db.run(
    `INSERT INTO weekly_digests (team_id, week, body, source, created_at, created_by)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(team_id, week) DO UPDATE SET
       body = excluded.body,
       source = excluded.source,
       created_at = excluded.created_at,
       created_by = excluded.created_by`,
    [digest.teamId, digest.week, digest.body, digest.source, now, digest.createdBy],
  );
  return { ...digest, createdAt: now };
}

/* ------------------------------------------------------------------ *
 * 만들기
 * ------------------------------------------------------------------ */

const SYSTEM_PROMPT = [
  "너는 인프라 지원팀의 주간 업무 정리를 다듬는다.",
  "입력은 그 주의 일정과 작업 메모를 규칙대로 모아 놓은 글이다.",
  "",
  "규칙:",
  "- **사실을 더하지 마라.** 입력에 없는 일정·사람·숫자를 만들면 안 된다.",
  "- 사람별 섹션 구조와 건수를 그대로 지켜라.",
  "- 개조식으로, 한 줄에 한 가지만. 한국어.",
  "- 메모가 있으면 그 내용을 그 일정 아래 한 줄로 요약해라.",
  "- 맨 끝에 '다음 주로 넘어가는 것' 을 남겨라.",
  "- 머리말·맺음말·인사말을 붙이지 마라.",
].join("\n");

export interface BuildOptions {
  /** 누가 만들었나(화면 표시용). 자동 실행이면 빈 문자열. */
  readonly actor?: string;
  /** LLM 을 쓰지 않는다. 시험과 "원본 그대로 보기" 에 쓴다. */
  readonly ruleOnly?: boolean;
  /**
   * LLM 호출. 기본은 lib/aiChat.ts 의 chat 이다.
   *
   * 인자로 받는 이유는 **시험 때문**이다 — aiChat 은 DB 와 네트워크를 함께 쓴다.
   * 여기서 갈라 두면 "LLM 이 실패해도 정리는 나온다" 를 시험으로 잠글 수 있다.
   */
  readonly chat?: (system: string, user: string) => Promise<string>;
}

/**
 * 그 주의 정리를 만들어 저장한다.
 *
 * LLM 이 실패하면 **규칙 기반 글을 그대로 저장한다.** 던지지 않는다 — 이 함수가
 * 던지면 "정리가 아예 없는 주" 가 생기고, 그게 LLM 장애 때마다 반복된다.
 */
export async function buildWeeklyDigest(
  db: Db,
  teamId: string,
  week: string,
  options: BuildOptions = {},
): Promise<WeeklyDigest> {
  assertValidTeamId(teamId);
  const input = await collectDigestInput(db, teamId, week);
  const rule = ruleBasedDigest(input);

  if (options.ruleOnly === true || input.events.length === 0) {
    return saveDigest(db, {
      teamId,
      week: input.week,
      body: rule,
      source: "rule",
      createdBy: options.actor ?? "",
    });
  }

  const call = options.chat ?? (async (system, user) => {
    // 기본 경로. 여기서만 aiChat 을 끌어온다 — 위쪽은 LLM 을 몰라도 된다.
    const { chatLong } = await import("./aiChat.ts");
    return chatLong(system, user, { maxTokens: 1200, temperature: 0.2 });
  });

  try {
    const polished = (await call(SYSTEM_PROMPT, rule)).trim();
    // 빈 응답이나 터무니없이 짧은 응답은 **쓰지 않는다.** 규칙 기반 글보다 나쁘다.
    if (polished.length < 40) {
      return saveDigest(db, {
        teamId, week: input.week, body: rule, source: "rule", createdBy: options.actor ?? "",
      });
    }
    return saveDigest(db, {
      teamId, week: input.week, body: polished, source: "llm", createdBy: options.actor ?? "",
    });
  } catch {
    // 실패 사유를 글에 섞지 않는다 — 정리는 사람이 읽는 문서다. 화면이 source 로
    // "규칙 기반" 임을 알려 준다.
    return saveDigest(db, {
      teamId, week: input.week, body: rule, source: "rule", createdBy: options.actor ?? "",
    });
  }
}

/* ------------------------------------------------------------------ *
 * 자동 실행 — 주마다 한 번
 * ------------------------------------------------------------------ */

const LAST_WEEK_KEY = "weekly_digest_last";

/**
 * "지난 주 정리가 아직 없으면 만든다." 캘린더 화면 진입이 이걸 깨운다.
 *
 * 왜 요일·시각을 보지 않는가: 이 레포의 웹은 **스스로 깨어나지 않는다**
 * (app/closed/AutoPublishKick.tsx 의 근거). cron 을 새로 들이는 대신, 사람이
 * 화면에 들어온 시점에 "지난 주 것이 없으면 만든다" 로 둔다. 금요일 17시에 정확히
 * 나오지는 않지만, **아무도 안 보는 정리가 제때 생기는 것보다 쓸모 있다.**
 *
 * `app_state` 에 마지막으로 만든 주를 적어 둔다 — 한 주에 한 번만 LLM 을 때린다.
 */
export async function autoBuildLastWeek(
  db: Db,
  teamId: string,
  today: string,
): Promise<WeeklyDigest | null> {
  const lastWeek = addDays(weekMondayOf(today), -7);

  const key = `${LAST_WEEK_KEY}:${teamId}`;
  if ((await getAppState(db, key)) === lastWeek) return null;

  const existing = await getWeeklyDigest(db, teamId, lastWeek);
  if (existing !== null) {
    await setAppState(db, key, lastWeek);
    return null;
  }

  // 지난 주에 아무 일정도 없으면 만들지 않는다 — 빈 정리가 쌓이면 목록이 쓸모없어진다.
  const input = await collectDigestInput(db, teamId, lastWeek);
  if (input.events.length === 0) {
    await setAppState(db, key, lastWeek);
    return null;
  }

  const made = await buildWeeklyDigest(db, teamId, lastWeek, { actor: "" });
  await setAppState(db, key, lastWeek);
  return made;
}
