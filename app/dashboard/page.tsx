/**
 * 대시보드 — "지금 내가 봐야 할 것" 한 장.
 *
 * ## 왜 목록이 아니라 이 화면이 첫 장인가
 *
 * 전에는 들어오면 바로 **진행중 케이스 목록**이었다. 그 목록은 "무엇이 있나" 를
 * 말하지만 "내가 무엇을 해야 하나" 는 말하지 않는다. 답을 얻으려면 메뉴를 네 번
 * 돌아야 했다 — 미읽음 답변, 이번 주 내 일정, 임박한 보안 공지, 수집이 살아 있나.
 *
 * 그래서 **행동이 필요한 것만** 모은다. 건수가 0 인 칸은 조용히 비워 두지 않고
 * "없음" 이라고 말한다 — 비어 있는 것과 못 읽은 것은 다르다.
 *
 * 모든 조회를 try 로 감싼다. 한 칸이 실패해도 나머지는 보여야 한다 — 대시보드가
 * 통째로 500 이 되면 그게 가장 쓸모없는 화면이다.
 */
import Link from "next/link";
import { requireUser } from "../../lib/appAuth.ts";
import { listEventsBetween, type TeamEventView } from "../../lib/calendar.ts";
import { openDb } from "../../lib/db.ts";
import { getLastRun, listCasesSplit, type CaseListRow } from "../../lib/queries.ts";
import { getSessionStatus } from "../../lib/sessionFile.ts";
import { describeWeek, weekRange } from "../../lib/weekRange.ts";
import { COLOR, Card, MONO_STACK, Notice, RADIUS, formatStamp } from "../ui.tsx";

export const dynamic = "force-dynamic";

/** 오늘(KST). 서버가 UTC 면 자정 무렵 하루가 밀린다(lib/jiraWrite.ts today() 와 같은 이유). */
function todayKst(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

interface JiraTrouble {
  readonly eventId: number;
  readonly title: string;
  readonly state: string;
}

export default async function DashboardPage() {
  const me = await requireUser("/dashboard");
  const today = todayKst();
  const week = weekRange(today);

  let openCases: CaseListRow[] = [];
  let lastRun: Awaited<ReturnType<typeof getLastRun>> = null;
  let events: TeamEventView[] = [];
  let jiraTrouble: JiraTrouble[] = [];
  const errors: string[] = [];

  try {
    openCases = (await listCasesSplit()).open;
  } catch (error) {
    errors.push(`케이스: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    lastRun = await getLastRun();
  } catch {
    // 수집 이력이 없을 수 있다. 아래에서 "기록 없음" 으로 보인다.
  }

  if (me.teamId !== "") {
    const db = await openDb();
    try {
      events = await listEventsBetween(db, me.teamId, week.from, week.to);
      const rows = await db.all<{ event_id: number; title: string; jira_state: string }>(
        `SELECT event_id, title, jira_state FROM team_events
          WHERE team_id = ? AND jira_state IN ('failed','unknown')
          ORDER BY event_id DESC LIMIT 5`,
        [me.teamId],
      );
      jiraTrouble = rows.map((r) => ({
        eventId: Number(r.event_id),
        title: r.title,
        state: r.jira_state,
      }));
    } catch (error) {
      errors.push(`일정: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await db.close();
    }
  }

  const unread = openCases.filter((c) => c.unread_replies > 0);
  const mine = events.filter((e) => e.assigneeUserId === me.userId);
  const todays = events.filter((e) => e.startDate <= today && e.endDate >= today);
  const undone = events.filter((e) => e.state === "planned" || e.state === "doing");
  const portal = getSessionStatus();
  const portalLive = portal.exists && !portal.expired;
  const collectBroken = lastRun !== null && lastRun.status !== "success";

  return (
    <>
      <header style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>
          {me.displayName === "" ? me.loginId : me.displayName} 님, 오늘 볼 것
        </h1>
        <p style={{ margin: "7px 0 0", fontSize: 13, color: COLOR.muted }}>
          {today} · 이번 주 {describeWeek(today)}
          {me.teamName !== "" && ` · ${me.teamName}`}
        </p>
      </header>

      {errors.length > 0 && (
        <Notice tone="warn">
          일부를 불러오지 못했습니다 — {errors.join(" / ")}
        </Notice>
      )}
      {me.teamId === "" && (
        <Notice tone="warn">
          속한 팀이 없어 일정이 보이지 않습니다.{" "}
          <Link href="/team" style={{ color: COLOR.warn }}>팀 화면</Link>에서 연결을 요청하세요.
        </Notice>
      )}

      {/* ── 숫자 한 줄 ─────────────────────────────────── */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
        gap: 12, marginBottom: 18,
      }}>
        <Stat
          label="내 답변 기다리는 SR"
          value={unread.length}
          href="/"
          tone={unread.length > 0 ? "alert" : "calm"}
        />
        <Stat label="오늘 일정" value={todays.length} href="/calendar" tone="calm" />
        <Stat
          label="이번 주 내 담당"
          value={mine.length}
          href="/calendar"
          tone={mine.length > 0 ? "accent" : "calm"}
        />
        <Stat
          label="이번 주 미완료"
          value={undone.length}
          href="/calendar"
          tone={undone.length > 0 ? "warn" : "calm"}
        />
      </div>

      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16,
      }}>
        {/* ── 내 답변을 기다리는 SR ─────────────────────── */}
        <Card style={{ padding: 18 }}>
          <SectionTitle title="내 답변을 기다리는 SR" href="/" linkLabel="전체" />
          {unread.length === 0 ? (
            <Empty>상대 답변 중 확인하지 않은 것이 없습니다.</Empty>
          ) : (
            <ul style={listStyle}>
              {unread.slice(0, 6).map((c) => (
                <li key={c.request_id} style={itemStyle}>
                  <Link href={`/cases/${c.request_id}`} style={{ color: COLOR.ink, textDecoration: "none" }}>
                    <span style={{ fontFamily: MONO_STACK, fontSize: 11.5, color: COLOR.muted, marginRight: 7 }}>
                      {c.request_id_formatted}
                    </span>
                    {c.subject === "" ? "(제목 없음)" : c.subject}
                  </Link>
                  <span style={{
                    marginLeft: 7, fontSize: 11, fontWeight: 700, color: "#fff",
                    background: COLOR.waitUs, padding: "1px 6px", borderRadius: RADIUS.badge,
                  }}>
                    {c.unread_replies}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* ── 이번 주 내 일정 ───────────────────────────── */}
        <Card style={{ padding: 18 }}>
          <SectionTitle title="이번 주 내 담당 일정" href="/calendar" linkLabel="캘린더" />
          {mine.length === 0 ? (
            <Empty>
              이번 주에 내가 담당인 일정이 없습니다. 캘린더에서 한 줄로 등록할 수 있습니다.
            </Empty>
          ) : (
            <ul style={listStyle}>
              {mine.slice(0, 8).map((e) => (
                <li key={e.eventId} style={itemStyle}>
                  <Link
                    href={`/calendar?event=${e.eventId}`}
                    style={{ color: COLOR.ink, textDecoration: "none" }}
                  >
                    <span style={{ fontFamily: MONO_STACK, fontSize: 11.5, color: COLOR.muted, marginRight: 7 }}>
                      {e.startDate.slice(5).replace("-", "/")}
                    </span>
                    {e.scopes !== "" && (
                      <span style={{ color: COLOR.accent, fontSize: 11.5, marginRight: 5 }}>
                        [{e.scopes}]
                      </span>
                    )}
                    {e.title}
                  </Link>
                  <StateDot state={e.state} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* ── 돌아가는 상태 ─────────────────────────────── */}
        <Card style={{ padding: 18 }}>
          <SectionTitle title="돌아가는 상태" href="/logs" linkLabel="수집 로그" />
          <ul style={listStyle}>
            <li style={itemStyle}>
              <span>포털 세션</span>
              <span style={{ color: portalLive ? COLOR.ok : COLOR.waitUs, fontWeight: 600 }}>
                {portalLive ? "살아 있음" : "끊김 — 재로그인 필요"}
              </span>
            </li>
            <li style={itemStyle}>
              <span>마지막 수집</span>
              <span style={{ color: collectBroken ? COLOR.waitUs : COLOR.body }}>
                {lastRun === null
                  ? "기록 없음"
                  : `${formatStamp(Date.parse(lastRun.started_at))} · ${lastRun.status}`}
              </span>
            </li>
            <li style={itemStyle}>
              <span>Jira 반영 실패</span>
              <span style={{ color: jiraTrouble.length > 0 ? COLOR.waitUs : COLOR.body }}>
                {jiraTrouble.length === 0 ? "없음" : `${jiraTrouble.length}건`}
              </span>
            </li>
          </ul>

          {!portalLive && (
            <p style={{ margin: "12px 0 0", fontSize: 12, color: COLOR.waitUs, lineHeight: 1.7 }}>
              포털 세션이 끊기면 수집과 SR 쓰기가 멈춥니다.{" "}
              <Link href="/settings/account" style={{ color: COLOR.waitUs }}>브로드컴 계정</Link>
              에서 상태를 확인하세요.
            </p>
          )}
          {jiraTrouble.length > 0 && (
            <ul style={{ ...listStyle, marginTop: 10 }}>
              {jiraTrouble.map((t) => (
                <li key={t.eventId} style={{ ...itemStyle, fontSize: 12 }}>
                  <Link href={`/calendar?event=${t.eventId}`} style={{ color: COLOR.waitUs }}>
                    {t.title}
                  </Link>
                  <span style={{ color: COLOR.faint, fontSize: 11 }}>
                    {t.state === "unknown" ? "만들어졌는지 확인 중" : "실패"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* ── 이번 주 팀 전체 ───────────────────────────── */}
        <Card style={{ padding: 18 }}>
          <SectionTitle title="이번 주 팀 전체" href="/calendar" linkLabel="캘린더" />
          {events.length === 0 ? (
            <Empty>이번 주에 등록된 일정이 없습니다.</Empty>
          ) : (
            <>
              <p style={{ margin: "0 0 10px", fontSize: 12.5, color: COLOR.body, lineHeight: 1.8 }}>
                일정 <strong>{events.length}</strong>건 · 완료{" "}
                {events.filter((e) => e.state === "done").length} · 진행{" "}
                {events.filter((e) => e.state === "doing").length} · 예정{" "}
                {events.filter((e) => e.state === "planned").length}
                {events.filter((e) => e.state === "canceled").length > 0 &&
                  ` · 취소 ${events.filter((e) => e.state === "canceled").length}`}
              </p>
              <ul style={listStyle}>
                {perPerson(events).map(([person, count]) => (
                  <li key={person} style={itemStyle}>
                    <span>{person}</span>
                    <span style={{ fontFamily: MONO_STACK, color: COLOR.muted }}>{count}건</span>
                  </li>
                ))}
              </ul>
              <p style={{ margin: "12px 0 0", fontSize: 12, color: COLOR.faint, lineHeight: 1.7 }}>
                주간 정리는 캘린더 화면 아래 「주간 정리」 에서 만듭니다.
              </p>
            </>
          )}
        </Card>
      </div>
    </>
  );
}

/** 사람별 건수. 담당 미지정은 맨 뒤로 보낸다. */
function perPerson(events: readonly TeamEventView[]): Array<[string, number]> {
  const map = new Map<string, number>();
  for (const e of events) {
    const name = e.assigneeName === "" ? "담당 미지정" : e.assigneeName;
    map.set(name, (map.get(name) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => {
    if (a[0] === "담당 미지정") return 1;
    if (b[0] === "담당 미지정") return -1;
    return b[1] - a[1] || a[0].localeCompare(b[0], "ko");
  });
}

function Stat({
  label, value, href, tone,
}: {
  label: string;
  value: number;
  href: string;
  tone: "calm" | "accent" | "warn" | "alert";
}) {
  const color = {
    calm: COLOR.muted,
    accent: COLOR.accent,
    warn: COLOR.warn,
    alert: COLOR.waitUs,
  }[tone];
  return (
    <Link href={href} style={{ textDecoration: "none" }}>
      <Card style={{ padding: "14px 16px" }}>
        <div style={{ fontSize: 11.5, color: COLOR.muted, fontWeight: 600 }}>{label}</div>
        <div style={{
          fontSize: 26, fontWeight: 700, color, marginTop: 4,
          fontFamily: MONO_STACK, fontVariantNumeric: "tabular-nums", lineHeight: 1.1,
        }}>
          {value}
        </div>
      </Card>
    </Link>
  );
}

function SectionTitle({ title, href, linkLabel }: { title: string; href: string; linkLabel: string }) {
  return (
    <div style={{
      display: "flex", alignItems: "baseline", justifyContent: "space-between",
      marginBottom: 12, gap: 10,
    }}>
      <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>{title}</h2>
      <Link href={href} style={{ fontSize: 11.5, color: COLOR.accent, textDecoration: "none" }}>
        {linkLabel} →
      </Link>
    </div>
  );
}

/** 비어 있는 것과 못 읽은 것은 다르다. 비었으면 그렇다고 말한다. */
function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ margin: 0, fontSize: 12.5, color: COLOR.faint, lineHeight: 1.7 }}>{children}</p>
  );
}

function StateDot({ state }: { state: string }) {
  const map: Record<string, { color: string; label: string }> = {
    planned: { color: COLOR.waitThem, label: "예정" },
    doing: { color: COLOR.warn, label: "진행" },
    done: { color: COLOR.ok, label: "완료" },
    canceled: { color: COLOR.faint, label: "취소" },
  };
  const it = map[state] ?? map.planned;
  return (
    <span style={{ fontSize: 11, color: it?.color, flexShrink: 0 }}>{it?.label}</span>
  );
}

const listStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: 7,
  fontSize: 13,
};

const itemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  lineHeight: 1.6,
};
