/**
 * 팀 캘린더.
 *
 * 요구의 핵심이 "등록·수정·삭제가 간편해야 한다" 였다. 그래서 중심이 **한 줄 입력**이고,
 * 칸 여섯 개짜리 모달은 쓰지 않는다(lib/quickAdd.ts 머리말).
 *
 * 달력 라이브러리를 쓰지 않는다 — 이 레포는 `node_modules` 를 통째로 드롭릿에 올리고
 * 사내망에서 npm 레지스트리에 닿는지가 불확실하다. CSS grid 로 직접 그린다.
 */
import { requireTeamUser } from "../../lib/appAuth.ts";
import { listEventsInMonth, type TeamEventView } from "../../lib/calendar.ts";
import { openDb } from "../../lib/db.ts";
import { listTeamMembers } from "../../lib/users.ts";
import { COLOR, Notice } from "../ui.tsx";
import { CalendarBoard, type MemberChip } from "./CalendarBoard.tsx";

export const dynamic = "force-dynamic";

/**
 * 오늘(KST). 서버가 UTC 일 수 있어 보정한다(lib/jiraWrite.ts 의 today() 와 같은 이유).
 *
 * 이 값을 화면에 **넘긴다.** 클라이언트가 자기 시계로 계산하면 서버가 먼저 그린
 * HTML 과 달라져 하이드레이션이 어긋난다(주 선택 목록이 한 칸씩 밀린다).
 */
function todayKst(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 'YYYY-MM'. */
function currentMonthKst(): string {
  return todayKst().slice(0, 7);
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const me = await requireTeamUser("/calendar");
  const params = await searchParams;

  const raw = typeof params.month === "string" ? params.month : "";
  const month = MONTH_PATTERN.test(raw) ? raw : currentMonthKst();
  const focusEvent = typeof params.event === "string" ? Number(params.event) : null;

  let events: TeamEventView[] = [];
  let members: MemberChip[] = [];
  let loadError: string | null = null;

  const db = await openDb();
  try {
    events = await listEventsInMonth(db, me.teamId, month);
    members = (await listTeamMembers(db, me.teamId)).map((m) => ({
      userId: m.userId,
      displayName: m.displayName,
      loginId: m.loginId,
      hasJira: m.jiraAccountId !== "",
    }));
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  } finally {
    await db.close();
  }

  return (
    <>
      <header style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>
          팀 캘린더
        </h1>
        <p style={{ margin: "7px 0 0", fontSize: 13, color: COLOR.muted, lineHeight: 1.7 }}>
          한 줄로 등록합니다 — <code style={{ fontSize: 12.5 }}>11/25 방화벽 점검 @용식 #점검</code>.
          일정은 같은 팀 모두에게 보이고, Jira 자동 등록이 켜져 있으면 이슈가 따라 만들어집니다.
        </p>
      </header>

      {loadError !== null && (
        <Notice tone="error">{`일정을 불러오지 못했습니다: ${loadError}`}</Notice>
      )}

      <CalendarBoard
        month={month}
        initialEvents={events}
        members={members}
        me={{ userId: me.userId, displayName: me.displayName }}
        today={todayKst()}
        focusEventId={focusEvent !== null && Number.isInteger(focusEvent) ? focusEvent : null}
      />
    </>
  );
}
