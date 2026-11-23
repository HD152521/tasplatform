/**
 * 대시보드 — "지금 내가 봐야 할 것" 한 장.
 *
 * ## 무엇을 뺐나
 *
 * 처음 만들 때는 "돌아가는 상태"(포털 세션·마지막 수집)를 카드로 뒀다. **사이드바 아래에
 * 이미 있는 것**이라 같은 말을 두 번 하고 있었다. 그래서 그 카드를 없애고, 손을 써야 할
 * 때(세션 끊김·Jira 반영 실패)만 **맨 위에 띠로** 올린다 — 평소에는 보이지 않는다.
 *
 * ## 숫자를 그림으로
 *
 * "완료 4 · 진행 2 · 예정 7" 은 읽어서 비교해야 한다. 같은 것을 길이로 보여 주면 보는
 * 순간 비율이 들어온다(app/dashboard/Charts.tsx). 다만 숫자를 지우지는 않는다 — 그림만
 * 있으면 정확한 값을 알 수 없다.
 *
 * 차트 라이브러리는 쓰지 않는다(의존성 0). div 와 인라인 SVG 로 그린다.
 *
 * 모든 조회를 각각 try 로 감싼다. 한 칸이 실패해도 나머지는 보여야 한다 — 대시보드가
 * 통째로 500 이 되면 그게 가장 쓸모없는 화면이다.
 */
import Link from "next/link";
import { requireUser } from "../../lib/appAuth.ts";
import { listEventsBetween, type EventState, type TeamEventView } from "../../lib/calendar.ts";
import { openDb } from "../../lib/db.ts";
import { getLastRun, listCasesSplit, type CaseListRow } from "../../lib/queries.ts";
import { getSessionStatus } from "../../lib/sessionFile.ts";
import { addDays } from "../../lib/quickAdd.ts";
import { describeWeek, weekMondayOf, weekRange } from "../../lib/weekRange.ts";
import { COLOR, Card, MONO_STACK, Notice, RADIUS } from "../ui.tsx";
import { DigestCard } from "./DigestCard.tsx";
import { BarList, Donut, StackBar, type BarRow } from "./Charts.tsx";

export const dynamic = "force-dynamic";

/** 오늘(KST). 서버가 UTC 면 자정 무렵 하루가 밀린다(lib/jiraWrite.ts today() 와 같은 이유). */
function todayKst(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const STATE_COLOR: Record<EventState, string> = {
  done: COLOR.ok,
  doing: COLOR.warn,
  planned: COLOR.waitThem,
  canceled: COLOR.faint,
};

export default async function DashboardPage() {
  const me = await requireUser("/dashboard");
  const today = todayKst();
  const week = weekRange(today);
  // 지난 주 정리는 **지난 주 월요일**로 찾는다. 일요일이 다음 주로 넘어가지 않게
  // weekMondayOf 가 -6 을 쓴다(lib/weekRange.ts).
  const lastWeek = weekMondayOf(addDays(today, -7));

  let openCases: CaseListRow[] = [];
  let lastRun: Awaited<ReturnType<typeof getLastRun>> = null;
  let events: TeamEventView[] = [];
  let jiraFailed = 0;
  const errors: string[] = [];

  try {
    // **그 사람과 그 팀 것만.** 전에는 팀을 안 걸러 다른 팀 케이스가 섞였고, 미읽음은
    // 팀이 공유해 한 사람이 열면 모두의 배지가 사라졌다(lib/schema.ts case_reads_user).
    openCases = (
      await listCasesSplit({
        teamId: me.teamId === "" ? undefined : me.teamId,
        userId: me.userId,
      })
    ).open;
  } catch (error) {
    errors.push(`케이스: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    lastRun = await getLastRun();
  } catch {
    // 수집 이력이 없을 수 있다.
  }

  if (me.teamId !== "") {
    const db = await openDb();
    try {
      events = await listEventsBetween(db, me.teamId, week.from, week.to);
      const row = await db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM team_events
          WHERE team_id = ? AND jira_state IN ('failed','unknown')`,
        [me.teamId],
      );
      jiraFailed = Number(row?.n ?? 0);
    } catch (error) {
      errors.push(`일정: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await db.close();
    }
  }

  const unread = openCases.filter((c) => c.unread_replies > 0);
  const mine = events.filter((e) => e.assigneeUserId === me.userId);
  const todays = events.filter((e) => e.startDate <= today && e.endDate >= today);
  const done = events.filter((e) => e.state === "done").length;
  const portal = getSessionStatus(me.teamId === "" ? undefined : me.teamId);
  const portalLive = portal.exists && !portal.expired;
  const collectBroken = lastRun !== null && lastRun.status !== "success";

  // 사람별 — 나를 강조한다. 담당 미지정은 맨 뒤.
  const byPerson: BarRow[] = (() => {
    const map = new Map<string, { value: number; highlight: boolean }>();
    for (const e of events) {
      const name = e.assigneeName === "" ? "담당 미지정" : e.assigneeName;
      const cur = map.get(name) ?? { value: 0, highlight: e.assigneeUserId === me.userId };
      map.set(name, { value: cur.value + 1, highlight: cur.highlight || e.assigneeUserId === me.userId });
    }
    return [...map.entries()]
      .map(([label, v]) => ({ label, value: v.value, highlight: v.highlight }))
      .sort((a, b) => {
        if (a.label === "담당 미지정") return 1;
        if (b.label === "담당 미지정") return -1;
        return b.value - a.value || a.label.localeCompare(b.label, "ko");
      });
  })();

  // 망별 — 여러 망에 걸친 일정은 각 망에 센다(제목 대괄호가 그렇게 돼 있다).
  const byScope: BarRow[] = (() => {
    const map = new Map<string, number>();
    for (const e of events) {
      for (const scope of e.scopes.split("/").filter((p) => p !== "")) {
        map.set(scope, (map.get(scope) ?? 0) + 1);
      }
    }
    return [...map.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  })();

  return (
    <>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>
          {me.displayName === "" ? me.loginId : me.displayName} 님, 오늘 볼 것
        </h1>
        <p style={{ margin: "7px 0 0", fontSize: 13, color: COLOR.muted }}>
          {today} ({describeWeek(today)})
          {me.teamName !== "" && ` · ${me.teamName}`}
        </p>
      </header>

      {errors.length > 0 && (
        <Notice tone="warn">일부를 불러오지 못했습니다 — {errors.join(" / ")}</Notice>
      )}
      {me.teamId === "" && (
        <Notice tone="warn">
          속한 팀이 없어 일정이 보이지 않습니다.{" "}
          <Link href="/team" style={{ color: COLOR.warn }}>팀 화면</Link>에서 연결을 요청하세요.
        </Notice>
      )}

      {/*
        손을 써야 할 때만 띠로 올린다. 평소에는 보이지 않는다 —
        늘 보이는 "상태 카드" 는 사이드바 아래와 겹쳐 같은 말을 두 번 하는 것이었다.
      */}
      {(!portalLive || collectBroken || jiraFailed > 0) && (
        <div style={{
          display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center",
          background: COLOR.waitUsBg, border: `1px solid #f3c7c2`,
          borderRadius: RADIUS.card, padding: "11px 15px", marginBottom: 16,
          fontSize: 12.5, lineHeight: 1.6,
        }}>
          <strong style={{ color: COLOR.waitUs }}>손 볼 것</strong>
          {!portalLive && (
            <Link href="/settings/account" style={{ color: COLOR.waitUs }}>
              포털 세션 끊김 — 재로그인 필요
            </Link>
          )}
          {collectBroken && (
            <Link href="/logs" style={{ color: COLOR.waitUs }}>
              마지막 수집 실패 ({lastRun?.status})
            </Link>
          )}
          {jiraFailed > 0 && (
            <Link href="/calendar" style={{ color: COLOR.waitUs }}>
              Jira 반영 실패 {jiraFailed}건
            </Link>
          )}
        </div>
      )}

      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16,
      }}>
        {/* ── 내 답변을 기다리는 SR ─────────────────────── */}
        <Card style={{ padding: 18 }}>
          <SectionTitle title="내 답변을 기다리는 SR" href="/" linkLabel="전체" />
          <div style={{ marginBottom: 14 }}>
            <Donut
              done={unread.length}
              total={openCases.length}
              label="진행중 중 미확인 답변"
              color={unread.length > 0 ? COLOR.waitUs : COLOR.ok}
            />
          </div>
          {unread.length === 0 ? (
            <Empty>상대 답변 중 확인하지 않은 것이 없습니다.</Empty>
          ) : (
            <ul style={listStyle}>
              {unread.slice(0, 5).map((c) => (
                <li key={c.request_id} style={itemStyle}>
                  <Link href={`/cases/${c.request_id}`} style={{ color: COLOR.ink, textDecoration: "none" }}>
                    <span style={{ fontFamily: MONO_STACK, fontSize: 11.5, color: COLOR.muted, marginRight: 7 }}>
                      {c.request_id_formatted}
                    </span>
                    {c.subject === "" ? "(제목 없음)" : c.subject}
                  </Link>
                  <span style={{
                    fontSize: 11, fontWeight: 700, color: "#fff", flexShrink: 0,
                    background: COLOR.waitUs, padding: "1px 6px", borderRadius: RADIUS.badge,
                  }}>
                    {c.unread_replies}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* ── 이번 주 진행 ──────────────────────────────── */}
        <Card style={{ padding: 18 }}>
          <SectionTitle title="이번 주 진행" href="/calendar" linkLabel="캘린더" />
          <div style={{ marginBottom: 14 }}>
            <Donut done={done} total={events.length} label="이번 주 완료율" />
          </div>
          <StackBar
            slices={(["done", "doing", "planned", "canceled"] as EventState[]).map((state) => ({
              label: { done: "완료", doing: "진행", planned: "예정", canceled: "취소" }[state],
              value: events.filter((e) => e.state === state).length,
              color: STATE_COLOR[state],
            }))}
          />
          <div style={{
            marginTop: 14, paddingTop: 12, borderTop: `1px solid ${COLOR.divider}`,
            fontSize: 12.5, color: COLOR.body, display: "flex", gap: 16, flexWrap: "wrap",
          }}>
            <span>오늘 <strong style={{ fontFamily: MONO_STACK }}>{todays.length}</strong>건</span>
            <span>내 담당 <strong style={{ fontFamily: MONO_STACK }}>{mine.length}</strong>건</span>
          </div>
        </Card>

        {/* ── 사람별 ────────────────────────────────────── */}
        <Card style={{ padding: 18 }}>
          <SectionTitle title="이번 주 사람별" href="/calendar" linkLabel="캘린더" />
          <BarList rows={byPerson} />
        </Card>

        {/* ── 망별 ──────────────────────────────────────── */}
        <Card style={{ padding: 18 }}>
          <SectionTitle title="이번 주 전산망별" href="/calendar" linkLabel="캘린더" />
          <BarList rows={byScope} />
          {byScope.length === 0 && events.length > 0 && (
            <p style={{ margin: "10px 0 0", fontSize: 11.5, color: COLOR.faint, lineHeight: 1.7 }}>
              일정에 전산망(#운영·#개발·#DR·#AWS)을 적으면 여기에 모입니다. Jira 제목의
              대괄호도 그 값으로 들어갑니다.
            </p>
          )}
        </Card>

        {/* ── 내 담당 일정 ──────────────────────────────── */}
        <Card style={{ padding: 18, gridColumn: "1 / -1" }}>
          <SectionTitle title="이번 주 내 담당 일정" href="/calendar" linkLabel="캘린더" />
          {mine.length === 0 ? (
            <Empty>이번 주에 내가 담당인 일정이 없습니다.</Empty>
          ) : (
            <ul style={listStyle}>
              {mine.map((e) => (
                <li key={e.eventId} style={itemStyle}>
                  <Link href={`/calendar?event=${e.eventId}`} style={{ color: COLOR.ink, textDecoration: "none" }}>
                    <span style={{ fontFamily: MONO_STACK, fontSize: 11.5, color: COLOR.muted, marginRight: 7 }}>
                      {e.startDate.slice(5).replace("-", "/")}
                      {e.endDate !== e.startDate && `~${e.endDate.slice(5).replace("-", "/")}`}
                    </span>
                    {e.scopes !== "" && (
                      <span style={{ color: COLOR.accent, fontSize: 11.5, marginRight: 5 }}>
                        [{e.scopes}]
                      </span>
                    )}
                    {e.title}
                  </Link>
                  <span style={{ fontSize: 11, color: STATE_COLOR[e.state], flexShrink: 0 }}>
                    {{ done: "완료", doing: "진행", planned: "예정", canceled: "취소" }[e.state]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* ── 지난 주 정리 ──────────────────────────────── */}
        {me.teamId !== "" && (
          <DigestCard week={lastWeek} today={today} label={describeWeek(lastWeek)} />
        )}
      </div>
    </>
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
  return <p style={{ margin: 0, fontSize: 12.5, color: COLOR.faint, lineHeight: 1.7 }}>{children}</p>;
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
