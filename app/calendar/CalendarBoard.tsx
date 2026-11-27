"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EventState, TeamEventView } from "../../lib/calendar.ts";
import { hiddenPerDay, layoutWeek, type WeekSegment } from "../../lib/calendarLanes.ts";
import {
  classifyTags,
  describeClassification,
  houseSummary,
} from "../../lib/jiraHouseStyle.ts";
import {
  addDays,
  daysInMonth,
  describeQuickAdd,
  formatQuickAddLine,
  parseQuickAdd,
  weekdayOf,
} from "../../lib/quickAdd.ts";
import {
  Badge,
  Button,
  COLOR,
  Card,
  Chip,
  Empty,
  LinkButton,
  MONO_STACK,
  Notice,
  RADIUS,
  SPACE,
  SectionHead,
  TEXT,
  Tab,
  WEIGHT,
  controlStyle,
  inputStyle,
} from "../ui.tsx";
import { EventPanel } from "./EventPanel.tsx";
import { TokenInput } from "./TokenInput.tsx";
import {
  EventForm,
  emptyFormValue,
  formValueOf,
  toPayload,
  type EventFormValue,
} from "./EventForm.tsx";

export interface MemberChip {
  readonly userId: number;
  readonly displayName: string;
  readonly loginId: string;
  readonly hasJira: boolean;
}

interface Props {
  readonly month: string;
  readonly initialEvents: readonly TeamEventView[];
  readonly members: readonly MemberChip[];
  readonly me: { userId: number; displayName: string };
  readonly focusEventId: number | null;
  /** 오늘(KST). 서버가 넘긴다 — 아래 todayLocal() 주석에 이유가 있다. */
  readonly today: string;
}

/** 처음 보여 줄 날짜. 이번 달을 보고 있으면 오늘, 다른 달이면 그 달 1일. */
function selectedDateInit(month: string, today: string): string {
  return today.startsWith(month) ? today : `${month}-01`;
}

const WEEK_LABELS = ["일", "월", "화", "수", "목", "금", "토"] as const;

/**
 * 달력 칸에 보여 줄 띠 줄 수의 상한.
 *
 * Jira 를 불러오면 한 날에 열 건이 넘는다. 전부 눕히면 한 주가 화면을 다 먹어
 * 달을 훑을 수 없다 — 달력은 "언제 무엇이 몰려 있나" 를 보는 곳이고, 그 날 전부는
 * 아래 목록에서 읽는다. 넘친 것은 `+N` 으로만 알린다.
 */
const LANE_LIMIT = 3;

/**
 * 칸 **아래에 늘 비워 두는 높이.**
 *
 * 띠가 세 줄 차고 `+N` 까지 붙으면 칸이 위에서 아래까지 띠로 덮여, 그 날을 고르려고
 * 눌러도 **일정이 열렸다.** 날 숫자 줄(위 20px)만 남아서, 일정이 몰린 주에는 사실상
 * 누를 자리가 없었다.
 *
 * 그래서 마지막 격자 줄을 `minmax(CLICK_GUTTER, 1fr)` 로 두고 **아무것도 얹지
 * 않는다.** 일정이 몇 건이든 칸마다 가로로 긴 빈 자리가 남아, 그 날을 고르는 손이
 * 갈 곳이 생긴다. 한가한 달에서는 `1fr` 이 늘어나 지금과 똑같이 보인다.
 */
const CLICK_GUTTER = 18;

/**
 * 저장된 일정을 **한 줄 태그**로 되살린다.
 *
 * 적은 태그는 저장될 때 망(scopes)·법인(corp)·성격(kind) 셋으로 갈라진다
 * (lib/jiraHouseStyle.ts). 인라인 편집은 그 줄을 다시 보여 줘야 하므로 셋을 합친다.
 * 순서는 저장 순서가 아니라 **망 → 법인 → 성격** 으로 고정한다 — 편집할 때마다
 * 순서가 흔들리면 같은 일정이 매번 다른 줄로 보인다.
 */
function tagsOf(event: TeamEventView): string[] {
  const scopes = event.scopes === "" ? [] : event.scopes.split("/").filter((s) => s !== "");
  return [...scopes, ...(event.corp === "" ? [] : [event.corp]), ...(event.kind === "" ? [] : [event.kind])];
}

/** 상태별 색. 취소는 지운 것과 다르다 — 보이되 흐리게 둔다. */
const STATE_STYLE: Record<EventState, { fg: string; bg: string; label: string }> = {
  planned: { fg: COLOR.waitThem, bg: COLOR.waitThemBg, label: "예정" },
  doing: { fg: COLOR.warn, bg: COLOR.warnBg, label: "진행" },
  done: { fg: COLOR.ok, bg: COLOR.okBg, label: "완료" },
  canceled: { fg: COLOR.faint, bg: COLOR.ground, label: "취소" },
};

/** 다음 상태. 칩을 누를 때마다 예정 → 진행 → 완료 → 예정 으로 돈다. */
const NEXT_STATE: Record<EventState, EventState> = {
  planned: "doing",
  doing: "done",
  done: "planned",
  canceled: "planned",
};

function monthShift(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const total = y * 12 + (m - 1) + delta;
  const year = Math.floor(total / 12);
  const mon = (total % 12) + 1;
  return `${year}-${String(mon).padStart(2, "0")}`;
}

/** 달 그리드에 그릴 42칸(6주). 앞뒤 달이 섞여 들어온다. */
function gridDates(month: string): string[] {
  const first = `${month}-01`;
  const [y, m] = month.split("-").map(Number) as [number, number];
  const weekday = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const start = addDays(first, -weekday);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export function CalendarBoard({ month, initialEvents, members, me, focusEventId, today }: Props) {
  const [events, setEvents] = useState<readonly TeamEventView[]>(initialEvents);
  const [selectedDate, setSelectedDate] = useState(() => selectedDateInit(month, today));
  const [line, setLine] = useState("");
  /**
   * 입력 방식. **폼이 기본**이다.
   *
   * 한 줄은 빠르지만 틀렸을 때 비싸다 — 날짜가 잘못 읽히면 등록한 뒤 찾아가서
   * 고쳐야 한다. 그리고 망·법인처럼 고를 수 있는 값은 외워서 적는 것보다 보고
   * 고르는 쪽이 정확하다. 익숙해지면 「한 줄로」 로 바꿔 쓴다.
   */
  const [mode, setMode] = useState<"form" | "line">("form");
  const [form, setForm] = useState<EventFormValue>(() => emptyFormValue(selectedDateInit(month, today)));
  /** 폼이 수정 중인 일정. null 이면 새로 등록하는 것이다. */
  const [formEditId, setFormEditId] = useState<number | null>(null);
  /**
   * 고치는 중인 일정에 **이미 Jira 이슈가 있는가.**
   *
   * 있으면 "메모로만" 으로 되돌릴 수 없다 — 끄는 것만으로 이슈가 사라지지 않고,
   * 동기화만 멈춘 채 Jira 에 남는다(서버도 같은 이유로 거절한다).
   */
  const [formJiraLocked, setFormJiraLocked] = useState(false);
  /**
   * 한 줄 입력으로 등록할 때 Jira 에 올릴 것인가. 기본은 올리지 않는다.
   *
   * 한 줄 입력은 여러 건을 잇따라 적는 자리라 **누른 값을 유지한다** — 작업 일정을
   * 연달아 적는 사람이 매번 다시 켜야 하면 그게 더 틀린다.
   */
  const [lineJira, setLineJira] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "warn"; text: string } | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLine, setEditLine] = useState("");
  const [openId, setOpenId] = useState<number | null>(focusEventId);
  /**
   * 입력칸을 펼쳤나.
   *
   * 기본은 **닫힘**이다. 이 화면에 들어오는 이유는 대개 "무엇이 있나" 를 보는
   * 것이고, 입력칸이 늘 펼쳐져 있으면 일정이 아래로 밀린다.
   */
  const [composing, setComposing] = useState(false);
  /** Jira 가져오기 시작 날짜. 기본은 서버가 정한다(이번 달 1일 또는 JIRA_IMPORT_FROM). */
  const [importFromDate, setImportFromDate] = useState("");
  const [importing, setImporting] = useState(false);

  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const dates = useMemo(() => gridDates(month), [month]);

  /** 날짜 칸 → 그 날에 걸치는 일정. 한 번만 만들어 둔다(42칸 × 일정 수를 매번 돌지 않게). */
  const byDate = useMemo(() => {
    const map = new Map<string, TeamEventView[]>();
    for (const event of events) {
      let cursor = event.startDate;
      // 아주 긴 일정이 그리드를 통째로 채우는 것을 막는다(366일 상한).
      for (let i = 0; i <= 366 && cursor <= event.endDate; i += 1) {
        const bucket = map.get(cursor);
        if (bucket === undefined) map.set(cursor, [event]);
        else bucket.push(event);
        cursor = addDays(cursor, 1);
      }
    }
    return map;
  }, [events]);

  /**
   * 주별 띠 배치. 이어지는 일정을 한 덩어리로 그리기 위한 계산은
   * lib/calendarLanes.ts 에 있다(머리말에 왜 점이 아니라 띠인지 적어 뒀다).
   */
  const weeks = useMemo(
    () =>
      Array.from({ length: dates.length / 7 }, (_, w) => {
        const span = dates.slice(w * 7, w * 7 + 7);
        return { dates: span, segments: layoutWeek(events, span) };
      }),
    [dates, events],
  );

  /**
   * 띠 줄을 몇 개까지 보여 줄지.
   *
   * **달 전체에서 같은 수**를 쓴다 — 주마다 높이가 달라지면 칸 크기가 들쭉날쭉해
   * 달을 훑는 눈이 걸린다. 가장 많이 겹친 주를 따르되 LANE_LIMIT 에서 끊고,
   * 넘친 것은 그 날 칸에 `+N` 으로 알린다.
   */
  const deepest = Math.max(
    0,
    ...weeks.map((w) => w.segments.reduce((m, s) => Math.max(m, s.lane + 1), 0)),
  );
  const laneRows = Math.max(1, Math.min(LANE_LIMIT, deepest));
  const anyOverflow = deepest > laneRows;

  /** 칸을 고른다. 폼으로 적고 있을 때도 그 날짜가 따라와야 한다 — 칸을 눌렀는데
   *  폼의 날짜가 그대로면 "눌러도 아무 일이 없는" 화면이 된다. */
  function pickDate(date: string): void {
    setSelectedDate(date);
    if (formEditId === null) setForm((prev) => ({ ...prev, startDate: date, endDate: date }));
    if (mode === "line") inputRef.current?.focus();
  }

  /**
   * 미리보기. 파서가 어떻게 읽었는지와 **Jira 에 어떤 제목으로 올라갈지**를 함께 보여
   * 준다. 제목 규칙(망 대괄호·법인 에픽)이 눈에 보이지 않으면 아무도 `#운영` 을 적지
   * 않는다 — 그러면 보고서 집계가 그 건의 망을 읽지 못한다.
   */
  const preview = useMemo(() => {
    if (line.trim() === "") return null;
    try {
      const parsed = parseQuickAdd(line, selectedDate);
      const { summary, ...rest } = parsed;
      const tags = classifyTags(parsed.kinds);
      const jiraTitle = houseSummary({
        scopes: tags.scopes,
        corp: tags.corp,
        title: parsed.title,
      });
      return {
        read: describeQuickAdd(rest),
        jira: parsed.title === "" ? "" : `Jira: ${jiraTitle}  ·  ${describeClassification(tags)}`,
        error: "",
      };
    } catch (error) {
      return { read: "", jira: "", error: error instanceof Error ? error.message : String(error) };
    }
  }, [line, selectedDate]);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/calendar?month=${encodeURIComponent(month)}`);
      const data = (await res.json()) as { ok?: boolean; events?: TeamEventView[] };
      if (data.ok === true && data.events !== undefined) setEvents(data.events);
    } catch {
      // 목록 새로 읽기 실패는 조용히 둔다 — 방금 한 동작의 결과는 이미 안내했다.
    }
  }, [month]);

  /**
   * 밀린 Jira 반영을 **화면 진입이 깨운다.**
   *
   * 웹은 스스로 깨어나지 않는다(app/closed/AutoPublishKick.tsx 의 근거와 같다).
   * 멱등하므로 여러 사람이 동시에 열어도 이슈가 중복되지 않는다.
   */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/calendar/jira-sync", { method: "POST" });
        const data = (await res.json()) as { ok?: boolean; results?: Array<{ action: string }> };
        if (!alive) return;
        const done = (data.results ?? []).filter((r) => r.action !== "skipped");
        if (done.length > 0) await reload();
      } catch {
        // Jira 가 죽어 있어도 캘린더는 그대로 쓴다.
      }
    })();
    return () => {
      alive = false;
    };
  }, [reload]);

  async function call(
    url: string,
    init: RequestInit,
    okText: string,
  ): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(url, init);
      const data = (await res.json()) as Record<string, unknown>;
      if (data.ok === true) {
        const jira = data.jira as { message?: string; leftBehind?: boolean } | null | undefined;
        const extra = jira?.message === undefined ? "" : ` ${jira.message}`;
        setMessage({
          tone: jira?.leftBehind === true ? "warn" : "ok",
          text: `${okText}${extra}`,
        });
        await reload();
        return data;
      }
      setMessage({ tone: "error", text: String(data.message ?? "실패했습니다.") });
      return null;
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      setBusy(false);
    }
  }

  const add = async (): Promise<void> => {
    if (line.trim() === "") return;
    const result = await call(
      "/api/calendar",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line, today: selectedDate, jiraWanted: lineJira }),
      },
      "일정을 등록했습니다.",
    );
    if (result !== null) {
      setLine("");
      // 한 줄 입력은 **열어 둔다** — 여러 건을 잇따라 적는 방식이라 닫으면 방해다.
      inputRef.current?.focus();
    }
  };

  /** 폼으로 등록하거나 고친다. 한 줄 경로와 **같은 분류 함수**를 거친다. */
  const saveForm = async (): Promise<void> => {
    if (form.title.trim() === "") return;
    const payload = toPayload(form);
    const result =
      formEditId === null
        ? await call(
            "/api/calendar",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            },
            "일정을 등록했습니다.",
          )
        : await call(
            "/api/calendar",
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...payload, eventId: formEditId }),
            },
            "일정을 고쳤습니다.",
          );
    if (result !== null) {
      setFormJiraLocked(false);
      setForm(emptyFormValue(selectedDate));
      setFormEditId(null);
      // 저장하면 닫는다. 이 화면의 주인공은 목록이고, 방금 넣은 것이 거기 보여야 한다.
      setComposing(false);
    }
  };

  const saveEdit = async (eventId: number): Promise<void> => {
    if (editLine.trim() === "") return;
    const result = await call(
      "/api/calendar",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, line: editLine, today: selectedDate }),
      },
      "일정을 고쳤습니다.",
    );
    if (result !== null) setEditingId(null);
  };

  const cycleState = (event: TeamEventView): Promise<unknown> =>
    call(
      "/api/calendar",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: event.eventId, state: NEXT_STATE[event.state] }),
      },
      `「${event.title}」 → ${STATE_STYLE[NEXT_STATE[event.state]].label}.`,
    );

  const remove = async (event: TeamEventView): Promise<void> => {
    // Jira 이슈까지 지운다 — **되돌릴 수 없다.** 그래서 키를 보여 주고 한 번 더 묻는다.
    const warn =
      event.jiraKey === ""
        ? `「${event.title}」 일정을 지울까요?`
        : `「${event.title}」 일정과 Jira 이슈 ${event.jiraKey} 를 함께 지울까요?\n이슈 삭제는 되돌릴 수 없습니다.`;
    if (!window.confirm(warn)) return;
    const result = await call(
      `/api/calendar?eventId=${event.eventId}`,
      { method: "DELETE" },
      "일정을 지웠습니다.",
    );
    if (result !== null) {
      setOpenId(null);
      setEditingId(null);
    }
  };

  /* 키보드. 입력칸 안에서는 동작하지 않는다 — 제목에 't' 를 치면 달이 바뀌면 안 된다. */
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      const typing =
        target !== null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if (e.key === "Escape") {
        setEditingId(null);
        setOpenId(null);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "n") {
        e.preventDefault();
        setComposing(true);
        inputRef.current?.focus();
      } else if (e.key === "ArrowLeft") {
        window.location.href = `/calendar?month=${monthShift(month, -1)}`;
      } else if (e.key === "ArrowRight") {
        window.location.href = `/calendar?month=${monthShift(month, 1)}`;
      } else if (e.key === "t") {
        window.location.href = "/calendar";
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [month]);

  // 가져오기 기본 시작점은 서버가 정한다(설정값일 수 있어 화면이 추측하지 않는다).
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/calendar/import");
        const data = (await res.json()) as { ok?: boolean; from?: string };
        if (alive && data.ok === true && typeof data.from === "string") {
          setImportFromDate((prev) => (prev === "" ? data.from as string : prev));
        }
      } catch {
        // 못 읽으면 입력칸이 비어 있고, 누르면 서버가 기본값을 쓴다.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Jira 에 이미 있는 작업을 캘린더로 가져온다.
   *
   * 사람이 눌러야 돈다 — 몇백 건을 훑는 조회라 느리고, 자동으로 돌면 "왜 과거
   * 일정이 갑자기 생겼나" 를 설명할 수 없다. 여러 번 눌러도 중복되지 않는다.
   */
  async function runImport(): Promise<void> {
    setImporting(true);
    setMessage(null);
    try {
      const res = await fetch("/api/calendar/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: importFromDate }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        message?: string;
        created?: number;
        unmatchedAssignee?: number;
      };
      setMessage({
        tone: data.ok !== true ? "error" : (data.unmatchedAssignee ?? 0) > 0 ? "warn" : "ok",
        text: data.message ?? "가져왔습니다.",
      });
      if (data.ok === true) await reload();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setImporting(false);
    }
  }

  const open = events.find((e) => e.eventId === openId) ?? null;
  const [year, mon] = month.split("-").map(Number) as [number, number];

  return (
    <>
      {message !== null && <Notice tone={message.tone}>{message.text}</Notice>}


      {/* ── 달 이동 ────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <a href={`/calendar?month=${monthShift(month, -1)}`} style={{ ...controlStyle, textDecoration: "none" }}>
          ←
        </a>
        <div style={{ fontSize: 17, fontWeight: 700, minWidth: 130 }}>
          {year}년 {mon}월
        </div>
        <a href={`/calendar?month=${monthShift(month, 1)}`} style={{ ...controlStyle, textDecoration: "none" }}>
          →
        </a>
        <a href="/calendar" style={{ ...controlStyle, textDecoration: "none", fontSize: TEXT.small }}>
          오늘
        </a>
        <Button
          kind={composing ? "default" : "primary"}
          size="small"
          onClick={() => {
            // 닫을 때는 수정 중이던 것도 함께 놓는다 — 닫힌 폼이 수정 상태를
            // 들고 있으면 다음에 열 때 엉뚱한 일정을 고치게 된다.
            if (composing) {
              setComposing(false);
              setFormEditId(null);
              setFormJiraLocked(false);
              setForm(emptyFormValue(selectedDate));
            } else {
              setComposing(true);
            }
          }}
        >
          {composing ? "입력 닫기" : "+ 일정 등록"}
        </Button>
        <div style={{
          marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
        }}>
          <span style={{ fontSize: 11.5, color: COLOR.faint }}>
            n 입력 · ← → 달 · t 오늘 · Esc 닫기
          </span>
          <span style={{ width: 1, height: 18, background: COLOR.line }} />
          <input
            type="date"
            value={importFromDate}
            onChange={(e) => setImportFromDate(e.target.value)}
            title="이 날짜 이후에 시작한 Jira 작업을 가져옵니다"
            style={{ ...controlStyle, padding: "5px 8px", fontSize: 12, cursor: "text" }}
          />
          <button
            type="button"
            onClick={() => void runImport()}
            disabled={importing || busy}
            title="Jira 에 이미 있는 작업을 캘린더로 가져옵니다. 여러 번 눌러도 중복되지 않습니다."
            style={{ ...controlStyle, padding: "5px 10px", fontSize: 12, opacity: importing ? 0.6 : 1 }}
          >
            {importing ? "가져오는 중…" : "Jira 에서 가져오기"}
          </button>
        </div>
      </div>

      {/* ── 달 그리드 ──────────────────────────────────── */}
      <Card style={{ overflow: "hidden", marginBottom: 18 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)" }}>
          {WEEK_LABELS.map((label, i) => (
            <div key={label} style={{
              padding: "8px 10px", fontSize: 11.5, fontWeight: 600,
              borderBottom: `1px solid ${COLOR.line}`,
              color: i === 0 ? COLOR.waitUs : i === 6 ? COLOR.waitThem : COLOR.muted,
              background: COLOR.surface,
            }}>
              {label}
            </div>
          ))}
        </div>

        {/*
          **한 주가 한 격자다.**

          42칸을 한 격자에 넣으면 띠가 칸 경계를 넘을 수 없어, 이어지는 일정을
          날마다 끊어 그리게 된다. 주별로 쪼개면 띠 하나가
          `grid-column: 시작 / span 며칠` 한 줄로 끝난다.

          칸 배경은 `grid-row: 1 / -1` 로 주 전체 높이를 덮고, 띠는 그 위 줄에
          얹는다 — 겹치는 격자 항목은 **뒤에 온 것이 위에** 그려지므로 순서가 맞다.
        */}
        {weeks.map((wk, wi) => {
          const hidden = hiddenPerDay(wk.segments, laneRows, wk.dates.length);
          return (
            <div
              key={wk.dates[0]}
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(7, 1fr)",
                // 마지막 줄은 비워 둔다 — 그 날을 고르는 자리(CLICK_GUTTER 머리말).
                gridTemplateRows:
                  `20px repeat(${laneRows}, 18px)${anyOverflow ? " 14px" : ""}` +
                  ` minmax(${CLICK_GUTTER}px, 1fr)`,
                minHeight: 74,
                borderBottom: wi < weeks.length - 1 ? `1px solid ${COLOR.divider}` : "none",
              }}
            >
              {wk.dates.map((date, c) => {
                const inMonth = date.startsWith(month);
                const isToday = date === today;
                const isSelected = date === selectedDate;
                return (
                  <div
                    key={date}
                    onClick={() => pickDate(date)}
                    title={`${date} — 누르면 이 날 전부가 아래에 열립니다`}
                    style={{
                      gridColumn: c + 1,
                      gridRow: "1 / -1",
                      cursor: "pointer",
                      padding: "3px 6px 0",
                      borderRight: c === 6 ? "none" : `1px solid ${COLOR.divider}`,
                      background: isSelected ? COLOR.accentWash : inMonth ? COLOR.surface : COLOR.ground,
                      outline: isToday ? `2px solid ${COLOR.accent}` : "none",
                      outlineOffset: -2,
                    }}
                  >
                    <div style={{
                      fontSize: 11.5, fontFamily: MONO_STACK,
                      color: inMonth ? (isToday ? COLOR.accent : COLOR.body) : COLOR.faint,
                      fontWeight: isToday ? 700 : 500,
                    }}>
                      {Number(date.slice(8, 10))}
                    </div>
                  </div>
                );
              })}

              {wk.segments
                .filter((seg) => seg.lane < laneRows)
                .map((seg) => (
                  <EventBar
                    key={`${seg.item.eventId}-${seg.col}`}
                    seg={seg}
                    mine={seg.item.assigneeUserId === me.userId}
                    onPick={() => {
                      pickDate(wk.dates[seg.col] as string);
                      setOpenId(seg.item.eventId);
                    }}
                  />
                ))}

              {/* 가려진 것은 그 날 칸에 숫자로만 알린다 — 전부는 아래 목록에서 읽는다. */}
              {anyOverflow &&
                hidden.map((n, c) =>
                  n === 0 ? null : (
                    <button
                      key={`more-${wk.dates[c]}`}
                      type="button"
                      onClick={() => pickDate(wk.dates[c] as string)}
                      title="이 날 전부를 아래 목록에서 봅니다"
                      style={{
                        gridColumn: c + 1, gridRow: laneRows + 2,
                        // 전에는 투명한 글자였다. 가려진 일정이 있다는 **유일한 신호**인데
                        // 흐려서 아무도 못 봤다. 알약 모양으로 묶어 누를 자리로도 보이게 한다.
                        justifySelf: "start", alignSelf: "center",
                        marginLeft: 4,
                        background: COLOR.subtle,
                        border: `1px solid ${COLOR.divider}`,
                        borderRadius: RADIUS.badge,
                        cursor: "pointer",
                        fontFamily: MONO_STACK, fontSize: 10, lineHeight: "12px",
                        color: COLOR.muted,
                        textAlign: "left", padding: "0 5px",
                      }}
                    >
                      +{n}
                    </button>
                  ),
                )}
            </div>
          );
        })}
      </Card>

      {/*
        입력은 **버튼을 누를 때만** 펼친다.

        전에는 입력칸이 화면 맨 위에 늘 펼쳐져 있었다. 그런데 이 화면에 들어오는
        이유는 열 번 중 아홉 번 "무엇이 있나" 를 보는 것이고, 등록은 한 번이다.
        늘 펼쳐 두면 **일정이 아래로 밀려** 스크롤해야 보인다. 보는 것을 먼저,
        적는 것을 버튼 뒤로 둔다.
      */}
      {composing && (
        <Card style={{ padding: "14px 16px", marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 6, marginBottom: 12, alignItems: "center" }}>
            <Tab active={mode === "form"} onClick={() => setMode("form")}>
              자세히 입력
            </Tab>
            <Tab active={mode === "line"} onClick={() => setMode("line")}>
              한 줄로
            </Tab>
            {formEditId !== null && (
              <span style={{ fontSize: 12, color: COLOR.accent, marginLeft: 6 }}>
                일정 #{formEditId} 수정 중
              </span>
            )}
          </div>

          {mode === "form" ? (
            <EventForm
              value={form}
              members={members}
              busy={busy}
              submitLabel={formEditId === null ? "일정 등록" : "수정 저장"}
              jiraLocked={formJiraLocked}
              onChange={setForm}
              onSubmit={() => void saveForm()}
              onCancel={
                formEditId === null
                  ? undefined
                  : () => {
                      setFormEditId(null);
                      setFormJiraLocked(false);
                      setForm(emptyFormValue(selectedDate));
                    }
              }
            />
          ) : (
          <>
          <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{
              fontSize: 12, fontWeight: 600, color: COLOR.body,
              background: COLOR.ground, padding: "7px 11px", borderRadius: RADIUS.control,
              fontFamily: MONO_STACK, flexShrink: 0,
            }}>
              {selectedDate}
            </div>
            {/*
              `@`·`#` 를 치면 목록이 뜬다(TokenInput). 망·법인·성격·팀원은 정해진 값이라
              외워 적게 하면 틀리고, 틀린 태그는 조용히 "성격" 으로 떨어져 Jira 제목의
              대괄호가 비어 버린다.
            */}
            <TokenInput
              focusRef={inputRef}
              value={line}
              onChange={setLine}
              onSubmit={() => void add()}
              members={members}
              triggers={["@", "#"]}
              disabled={busy}
              placeholder="11/25 정기점검 @용식 #운영 #DR #은   (날짜를 안 적으면 왼쪽 날짜)"
              inputStyle={{ minWidth: 220 }}
            />
            <button
              type="button"
              onClick={() => void add()}
              disabled={busy || line.trim() === ""}
              style={{
                ...controlStyle, background: COLOR.accent, color: "#fff", border: "none",
                fontWeight: 600, opacity: busy || line.trim() === "" ? 0.5 : 1,
              }}
            >
              등록
            </button>
          </div>

          {/*
            Jira 에 올릴지 고른다. **기본은 올리지 않는다** — 한 줄로 적히는 것은 이슈가
            될 일보다 그냥 적어 두는 일이 훨씬 많고, Jira 는 지워도 알림이 이미 간 뒤다.
            누른 값은 유지한다(작업 일정을 연달아 적는 사람이 매번 켜야 하면 그게 더 틀린다).
          */}
          <div style={{
            marginTop: 9, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center",
          }}>
            <Chip label="메모로만" active={!lineJira} onClick={() => setLineJira(false)} />
            <Chip label="Jira 에 올리기" active={lineJira} onClick={() => setLineJira(true)} />
            <span style={{ fontSize: 11.5, color: COLOR.faint }}>
              {lineJira ? "이슈가 만들어집니다." : "사내에만 남습니다. 나중에 올릴 수도 있습니다."}
            </span>
          </div>

          {/*
            미리보기. 파서가 틀리게 읽었으면 Enter 전에 눈에 보인다 —
            이게 한 줄 입력을 믿게 만드는 장치다.
          */}
          {/*
            읽은 결과는 **설명을 지우지 않고** 그 위에 덧붙인다.
            전에는 한 글자만 쳐도 문법 설명이 사라지고 다른 글이 그 자리에 들어왔다 —
            외우지 못한 사람은 그 순간 무엇을 적어야 하는지 알 길이 없어졌다.
          */}
          {preview !== null && (
            <div style={{
              marginTop: 10, padding: "9px 11px", borderRadius: RADIUS.control,
              background: preview.error !== "" ? COLOR.waitUsBg : COLOR.ground, fontSize: 12.5,
            }}>
              {preview.error !== "" ? (
                <span style={{ color: COLOR.waitUs }}>{preview.error}</span>
              ) : (
                <>
                  <div style={{ color: COLOR.body }}>{preview.read}</div>
                  {preview.jira !== "" && (
                    <div style={{ color: COLOR.accent, fontSize: 12, marginTop: 2 }}>{preview.jira}</div>
                  )}
                </>
              )}
            </div>
          )}

          <div style={{ marginTop: 10, fontSize: 12, color: COLOR.muted, lineHeight: 1.9 }}>
            <div><strong>날짜</strong> 11/25 · 11/25~27 · 25~27 · 내일 · 모레 (없으면 왼쪽 날짜)</div>
            <div><strong>시간</strong> 14:00 · 14:00-16:00 (없으면 종일)</div>
            <div><strong>@담당</strong> 팀원 이름이나 아이디</div>
            <div>
              <strong>#망</strong> 운영·개발·DR·AWS·검증·안성 ·{" "}
              <strong>#법인</strong> 은·중·본 · <strong>#성격</strong> 점검·작업·장애·회의
            </div>
            <div style={{ color: COLOR.faint }}>순서는 상관없습니다. 태그는 여러 개 적을 수 있습니다.</div>
          </div>
          </>
          )}
        </Card>
      )}

      {/*
        고른 날의 **자세한 목록**. 달력 칸에는 "있다" 만 보이고 내용은 여기서 읽는다.
        Jira 를 불러오면 한 날에 열 건이 넘기도 하는데, 그걸 칸 안에 넣으면 제목이
        전부 잘려 아무것도 읽을 수 없었다. 칸은 좁고 이 자리는 넓다.
      */}
      <Card style={{ marginBottom: SPACE.lg }}>
        <SectionHead
          title={`${selectedDate} (${weekdayOf(selectedDate)}) · ${byDate.get(selectedDate)?.length ?? 0}건`}
          right={
            <LinkButton
              onClick={() => {
                // 고른 날짜를 들고 입력칸을 연다 — 날짜를 다시 고르지 않게.
                setForm({ ...emptyFormValue(selectedDate) });
                setFormEditId(null);
                setComposing(true);
              }}
            >
              + 이 날에 등록
            </LinkButton>
          }
        />
        <DayList
          events={byDate.get(selectedDate) ?? []}
          date={selectedDate}
          meId={me.userId}
          busy={busy}
          editingId={editingId}
          editLine={editLine}
          onEditLineChange={setEditLine}
          onEditCommit={(id) => void saveEdit(id)}
          onEditCancel={() => setEditingId(null)}
          onOpen={setOpenId}
          onToggle={(event) => void cycleState(event)}
        />
      </Card>

      {open !== null && (
        <EventPanel
          event={open}
          members={members}
          busy={busy}
          onClose={() => setOpenId(null)}
          onEditForm={() => {
            setComposing(true);
            // 폼으로 고친다. 날짜·망·법인을 **보고 고를 수 있어야** 또 고치러 오지 않는다.
            setForm(formValueOf(open));
            setFormEditId(open.eventId);
            setFormJiraLocked(open.jiraKey !== "");
            setMode("form");
            setOpenId(null);
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
          onEditLine={() => {
            setComposing(true);
            setEditLine(
              formatQuickAddLine({
                startDate: open.startDate,
                endDate: open.endDate,
                startTime: open.startTime,
                endTime: open.endTime,
                title: open.title,
                kinds: tagsOf(open),
                assignee: open.assigneeLabel,
              }),
            );
            setSelectedDate(open.startDate);
            setEditingId(open.eventId);
            setOpenId(null);
          }}
          onDelete={() => void remove(open)}
          onChanged={reload}
          onMessage={setMessage}
        />
      )}

      <p style={{ fontSize: 12, color: COLOR.faint, lineHeight: 1.8 }}>
        날짜 칸을 누르면 그 날짜로 입력칸이 맞춰집니다. 일정을 누르면 상세·메모가 열리고,
        왼쪽 동그라미를 누르면 <strong>예정 → 진행 → 완료</strong> 로 바뀝니다. 그 변화는 Jira
        상태 전이로도 따라갑니다. 달의 날 수: {daysInMonth(year, mon)}일.
      </p>
    </>
  );
}


/**
 * 달력 칸 위에 눕는 일정 띠.
 *
 * **색은 상태, 길이는 기간이다.** 전에는 칸마다 색점을 찍었는데, 12~13일처럼
 * 이어지는 일정이 "하루짜리 둘" 과 구별되지 않았다. 기간은 길이로 보여야 기간으로
 * 읽힌다.
 *
 * 주 경계를 넘는 조각은 그 쪽 모서리를 깎지 않고 테두리도 넣지 않는다 — 다음 주
 * 줄의 조각과 **한 줄로 이어 보이게** 하려는 것이다(lib/calendarLanes.ts 가 어느
 * 쪽으로 더 가는지 알려 준다).
 *
 * 내 담당은 안쪽 테두리로 한 번 더 구분한다. 색만으로는 못 가른다.
 */
function EventBar({ seg, mine, onPick }: {
  seg: WeekSegment<TeamEventView>;
  mine: boolean;
  onPick: () => void;
}) {
  const event = seg.item;
  const style = STATE_STYLE[event.state];
  const period =
    event.endDate === event.startDate ? event.startDate : `${event.startDate} ~ ${event.endDate}`;

  return (
    <button
      type="button"
      onClick={onPick}
      title={[
        event.title,
        `${period} · ${style.label}`,
        event.assigneeName === "" ? "담당 미지정" : event.assigneeName,
        event.jiraKey,
      ]
        .filter((part) => part !== "")
        .join("\n")}
      style={{
        gridColumn: `${seg.col + 1} / span ${seg.span}`,
        gridRow: seg.lane + 2,
        alignSelf: "center",
        minWidth: 0,
        height: 16,
        lineHeight: "16px",
        // 이어지는 쪽은 여백을 두지 않는다 — 1px 만 벌어져도 끊겨 보인다.
        marginLeft: seg.continuesLeft ? 0 : 3,
        marginRight: seg.continuesRight ? 0 : 3,
        padding: `0 5px 0 ${seg.continuesLeft ? 5 : 4}px`,
        border: "none",
        borderLeft: seg.continuesLeft ? "none" : `3px solid ${style.fg}`,
        // 왼쪽은 **각지게** 둔다. 3px 색 띠에 둥근 모서리를 주면 괄호 "(" 처럼 보여
        // 제목 앞에 이상한 글자가 붙은 것으로 읽힌다(실제로 그렇게 보였다).
        borderTopLeftRadius: 0,
        borderBottomLeftRadius: 0,
        borderTopRightRadius: seg.continuesRight ? 0 : 3,
        borderBottomRightRadius: seg.continuesRight ? 0 : 3,
        background: style.bg,
        boxShadow: mine ? `inset 0 0 0 1px ${COLOR.accent}` : undefined,
        color: COLOR.ink,
        fontFamily: "inherit",
        fontSize: 11,
        fontWeight: mine ? WEIGHT.semibold : 400,
        textAlign: "left",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        textDecoration: event.state === "canceled" ? "line-through" : "none",
        cursor: "pointer",
      }}
    >
      {seg.continuesLeft && "‹ "}
      {event.scopes === "" ? "" : `[${event.scopes}] `}
      {event.title}
      {seg.continuesRight && " ›"}
    </button>
  );
}

/**
 * 고른 날의 일정 목록. 한 줄에 한 건, **잘리지 않게.**
 *
 * 인라인 한 줄 수정도 여기서 한다 — 달력 칸은 좁아 입력칸이 잘렸다.
 */
function DayList({
  events, date, meId, busy, editingId, editLine,
  onEditLineChange, onEditCommit, onEditCancel, onOpen, onToggle,
}: {
  events: readonly TeamEventView[];
  date: string;
  meId: number;
  busy: boolean;
  editingId: number | null;
  editLine: string;
  onEditLineChange: (next: string) => void;
  onEditCommit: (eventId: number) => void;
  onEditCancel: () => void;
  onOpen: (eventId: number) => void;
  onToggle: (event: TeamEventView) => void;
}) {
  if (events.length === 0) {
    return <Empty>이 날에는 일정이 없습니다. 위에서 등록할 수 있습니다.</Empty>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {events.map((event, index) => {
        const style = STATE_STYLE[event.state];
        const continued = event.startDate !== date;
        const multi = event.endDate !== event.startDate;

        if (editingId === event.eventId) {
          return (
            <div
              key={event.eventId}
              style={{ padding: `${SPACE.sm}px 0`, borderTop: index === 0 ? undefined : `1px solid ${COLOR.divider}` }}
            >
              <input
                value={editLine}
                autoFocus
                onChange={(e) => onEditLineChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onEditCommit(event.eventId);
                  } else if (e.key === "Escape") {
                    onEditCancel();
                  }
                }}
                style={{ ...inputStyle, fontSize: TEXT.small }}
              />
              <div style={{ fontSize: TEXT.micro, color: COLOR.faint, marginTop: SPACE.xs }}>
                Enter 저장 · Esc 취소
              </div>
            </div>
          );
        }

        return (
          <div
            key={event.eventId}
            style={{
              display: "flex", alignItems: "center", gap: SPACE.sm,
              padding: `${SPACE.sm}px 0`,
              borderTop: index === 0 ? undefined : `1px solid ${COLOR.divider}`,
              opacity: event.state === "canceled" ? 0.6 : 1,
            }}
          >
            {/* 상태 점. 누르면 예정 → 진행 → 완료 로 돈다. */}
            <button
              type="button"
              disabled={busy}
              onClick={() => onToggle(event)}
              title="예정 → 진행 → 완료"
              aria-label={`상태 바꾸기 (지금 ${style.label})`}
              style={{
                width: 12, height: 12, borderRadius: "50%", flexShrink: 0, padding: 0,
                border: `2px solid ${style.fg}`,
                background: event.state === "done" ? style.fg : "transparent",
                cursor: busy ? "default" : "pointer",
              }}
            />

            {/* 시각·기간. 종일이면 비워 두고 폭은 지킨다(줄이 흔들리지 않게). */}
            <span style={{
              width: 86, flexShrink: 0, fontFamily: MONO_STACK, fontSize: TEXT.micro,
              fontVariantNumeric: "tabular-nums", color: COLOR.muted,
            }}>
              {continued
                ? `↳ ${event.endDate.slice(5).replace("-", "/")}까지`
                : event.startTime === ""
                  ? multi
                    ? `~${event.endDate.slice(5).replace("-", "/")}`
                    : "종일"
                  : event.endTime === ""
                    ? event.startTime
                    : `${event.startTime}-${event.endTime}`}
            </span>

            {event.scopes !== "" && (
              <span style={{
                flexShrink: 0, fontSize: TEXT.micro, fontWeight: WEIGHT.semibold,
                color: COLOR.accent, background: COLOR.accentWash,
                padding: `1px ${SPACE.xs + 1}px`, borderRadius: RADIUS.badge,
              }}>
                {event.scopes}
              </span>
            )}

            <button
              type="button"
              onClick={() => onOpen(event.eventId)}
              style={{
                flex: 1, minWidth: 0, textAlign: "left", background: "transparent",
                border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit",
                fontSize: TEXT.base, color: COLOR.ink,
                fontWeight: event.assigneeUserId === meId ? WEIGHT.semibold : WEIGHT.normal,
                textDecoration: event.state === "canceled" ? "line-through" : "none",
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              }}
            >
              {event.title}
            </button>

            {event.noteCount > 0 && (
              <span style={{ fontSize: TEXT.micro, color: COLOR.faint, flexShrink: 0 }}>
                메모 {event.noteCount}
              </span>
            )}

            <span style={{
              flexShrink: 0, fontSize: TEXT.micro, color: COLOR.muted,
              width: 72, textAlign: "right", whiteSpace: "nowrap",
              overflow: "hidden", textOverflow: "ellipsis",
            }}>
              {event.assigneeName === "" ? "미지정" : event.assigneeName}
            </span>

            <Badge fg={style.fg} bg={style.bg}>{style.label}</Badge>

            {event.jiraKey !== "" && (
              <a
                href={event.jiraUrl}
                target="_blank"
                rel="noreferrer"
                style={{
                  flexShrink: 0, fontFamily: MONO_STACK, fontSize: TEXT.micro,
                  color: COLOR.accent, textDecoration: "none",
                }}
              >
                {event.jiraKey}
              </a>
            )}
            {(event.jiraState === "failed" || event.jiraState === "unknown") && (
              <span title={event.jiraError} style={{ fontSize: TEXT.micro, color: COLOR.waitUs, flexShrink: 0 }}>
                Jira !
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}