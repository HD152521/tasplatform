"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EventState, TeamEventView } from "../../lib/calendar.ts";
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
  COLOR,
  Card,
  Empty,
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
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "warn"; text: string } | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLine, setEditLine] = useState("");
  const [openId, setOpenId] = useState<number | null>(focusEventId);
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
        body: JSON.stringify({ line, today: selectedDate }),
      },
      "일정을 등록했습니다.",
    );
    if (result !== null) {
      setLine("");
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
      setForm(emptyFormValue(selectedDate));
      setFormEditId(null);
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

      {/* ── 일정 입력 ─────────────────────────────────── */}
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
            onChange={setForm}
            onSubmit={() => void saveForm()}
            onCancel={
              formEditId === null
                ? undefined
                : () => {
                    setFormEditId(null);
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
        <a href="/calendar" style={{ ...controlStyle, textDecoration: "none", fontSize: 12 }}>
          오늘
        </a>
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

          {dates.map((date, i) => {
            const inMonth = date.startsWith(month);
            const dayEvents = byDate.get(date) ?? [];
            const isToday = date === today;
            const isSelected = date === selectedDate;
            return (
              <div
                key={date}
                onClick={() => {
                  setSelectedDate(date);
                  // 폼으로 적고 있을 때도 그 날짜가 따라와야 한다 — 칸을 눌렀는데
                  // 폼의 날짜가 그대로면 "눌러도 아무 일이 없는" 화면이 된다.
                  if (formEditId === null) setForm((prev) => ({ ...prev, startDate: date, endDate: date }));
                  if (mode === "line") inputRef.current?.focus();
                }}
                style={{
                  minHeight: 68, padding: `${SPACE.xs + 1}px ${SPACE.sm - 2}px ${SPACE.sm - 2}px`,
                  cursor: "pointer",
                  borderBottom: i < 35 ? `1px solid ${COLOR.divider}` : "none",
                  borderRight: (i + 1) % 7 === 0 ? "none" : `1px solid ${COLOR.divider}`,
                  background: isSelected ? COLOR.accentWash : inMonth ? COLOR.surface : COLOR.ground,
                  outline: isToday ? `2px solid ${COLOR.accent}` : "none",
                  outlineOffset: -2,
                }}
              >
                <div style={{
                  fontSize: 11.5, fontFamily: MONO_STACK, marginBottom: 4,
                  color: inMonth ? (isToday ? COLOR.accent : COLOR.body) : COLOR.faint,
                  fontWeight: isToday ? 700 : 500,
                }}>
                  {Number(date.slice(8, 10))}
                </div>

                <DayCellSummary events={dayEvents} meId={me.userId} />
              </div>
            );
          })}
        </div>
      </Card>

      {/*
        고른 날의 **자세한 목록**. 달력 칸에는 "있다" 만 보이고 내용은 여기서 읽는다.
        Jira 를 불러오면 한 날에 열 건이 넘기도 하는데, 그걸 칸 안에 넣으면 제목이
        전부 잘려 아무것도 읽을 수 없었다. 칸은 좁고 이 자리는 넓다.
      */}
      <Card style={{ marginBottom: SPACE.lg }}>
        <SectionHead
          title={`${selectedDate} (${weekdayOf(selectedDate)}) · ${byDate.get(selectedDate)?.length ?? 0}건`}
          right={
            <span style={{ fontSize: TEXT.micro, color: COLOR.faint }}>
              달력에서 날짜를 누르면 그 날이 열립니다
            </span>
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
            // 폼으로 고친다. 날짜·망·법인을 **보고 고를 수 있어야** 또 고치러 오지 않는다.
            setForm(formValueOf(open));
            setFormEditId(open.eventId);
            setMode("form");
            setOpenId(null);
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
          onEditLine={() => {
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
 * 달력 한 칸의 요약.
 *
 * 제목을 늘어놓지 않는다 — Jira 를 불러오면 한 날에 열 건이 넘고, 좁은 칸에서는
 * 전부 잘려 **아무것도 읽을 수 없다.** 대신 "몇 건이 어떤 상태로 있는가" 만 색점으로
 * 보여 주고, 내용은 아래 목록에서 읽는다.
 *
 * 내 담당이 있으면 테두리 있는 점으로 표시한다 — 달을 훑을 때 제일 먼저 찾는 것이다.
 */
function DayCellSummary({ events, meId }: { events: readonly TeamEventView[]; meId: number }) {
  if (events.length === 0) return null;

  const shown = events.slice(0, 8);
  const mine = events.filter((e) => e.assigneeUserId === meId).length;

  return (
    <div
      title={events.map((e) => `${e.title}${e.assigneeName === "" ? "" : ` · ${e.assigneeName}`}`).join("\n")}
      style={{ display: "flex", flexDirection: "column", gap: SPACE.xs }}
    >
      <div style={{ display: "flex", gap: 3, flexWrap: "wrap", alignItems: "center" }}>
        {shown.map((event, i) => (
          <span
            key={`${event.eventId}-${i}`}
            style={{
              width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
              background: STATE_STYLE[event.state].fg,
              // 내 담당은 테두리로 한 번 더 구분한다(색만으로는 못 가른다).
              boxShadow: event.assigneeUserId === meId ? `0 0 0 2px ${COLOR.accentWash}` : undefined,
            }}
          />
        ))}
        {events.length > shown.length && (
          <span style={{ fontSize: 9, color: COLOR.faint, fontFamily: MONO_STACK }}>
            +{events.length - shown.length}
          </span>
        )}
      </div>
      <div style={{ fontSize: TEXT.micro, color: COLOR.muted, lineHeight: 1.4 }}>
        {events.length}건
        {mine > 0 && <span style={{ color: COLOR.accent, fontWeight: WEIGHT.semibold }}> · 내 {mine}</span>}
      </div>
    </div>
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