"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EventState, TeamEventView } from "../../lib/calendar.ts";
import {
  addDays,
  daysInMonth,
  describeQuickAdd,
  formatQuickAddLine,
  parseQuickAdd,
} from "../../lib/quickAdd.ts";
import { COLOR, Card, MONO_STACK, Notice, RADIUS, controlStyle } from "../ui.tsx";
import { EventPanel } from "./EventPanel.tsx";
import { WeeklyDigestCard } from "./WeeklyDigestCard.tsx";

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

const WEEK_LABELS = ["일", "월", "화", "수", "목", "금", "토"] as const;

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
  const [selectedDate, setSelectedDate] = useState(() =>
    // 이번 달을 보고 있으면 오늘, 다른 달이면 그 달 1일.
    today.startsWith(month) ? today : `${month}-01`,
  );
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "warn"; text: string } | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLine, setEditLine] = useState("");
  const [openId, setOpenId] = useState<number | null>(focusEventId);

  const inputRef = useRef<HTMLInputElement>(null);
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

  const preview = useMemo(() => {
    if (line.trim() === "") return null;
    try {
      const parsed = parseQuickAdd(line, selectedDate);
      const { summary, ...rest } = parsed;
      return describeQuickAdd(rest);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
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

  const open = events.find((e) => e.eventId === openId) ?? null;
  const [year, mon] = month.split("-").map(Number) as [number, number];

  return (
    <>
      {message !== null && <Notice tone={message.tone}>{message.text}</Notice>}

      {/* ── 한 줄 입력 ─────────────────────────────────── */}
      <Card style={{ padding: "14px 16px", marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{
            fontSize: 12, fontWeight: 600, color: COLOR.body,
            background: COLOR.ground, padding: "7px 11px", borderRadius: RADIUS.control,
            fontFamily: MONO_STACK, flexShrink: 0,
          }}>
            {selectedDate}
          </div>
          <input
            ref={inputRef}
            value={line}
            onChange={(e) => setLine(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void add();
              }
            }}
            placeholder="11/25 방화벽 점검 @용식 #점검   (날짜를 안 적으면 왼쪽 날짜)"
            disabled={busy}
            style={{ ...controlStyle, flex: "1 1 320px", cursor: "text", minWidth: 220 }}
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
        <div style={{
          marginTop: 9, fontSize: 12.5, minHeight: 18,
          color: preview === null ? COLOR.faint : COLOR.body,
        }}>
          {preview ?? "날짜·시간·@담당·#종류를 섞어 적을 수 있습니다. 순서는 상관없습니다."}
        </div>
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
        <div style={{ marginLeft: "auto", fontSize: 11.5, color: COLOR.faint }}>
          n 입력 · ← → 달 이동 · t 오늘 · Esc 닫기
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
                  inputRef.current?.focus();
                }}
                style={{
                  minHeight: 96, padding: "6px 7px 8px", cursor: "pointer",
                  borderBottom: i < 35 ? `1px solid ${COLOR.divider}` : "none",
                  borderRight: (i + 1) % 7 === 0 ? "none" : `1px solid ${COLOR.divider}`,
                  background: isSelected ? "#eef1f6" : inMonth ? COLOR.surface : "#fafbfc",
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

                {dayEvents.map((event) =>
                  editingId === event.eventId && date === event.startDate ? (
                    <input
                      key={`edit-${event.eventId}`}
                      value={editLine}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setEditLine(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void saveEdit(event.eventId);
                        } else if (e.key === "Escape") {
                          setEditingId(null);
                        }
                      }}
                      style={{
                        width: "100%", fontSize: 11, padding: "3px 5px", boxSizing: "border-box",
                        border: `1px solid ${COLOR.accent}`, borderRadius: 4, fontFamily: "inherit",
                      }}
                    />
                  ) : (
                    <EventChip
                      key={`${event.eventId}-${date}`}
                      event={event}
                      continued={date !== event.startDate}
                      mine={event.assigneeUserId === me.userId}
                      onOpen={() => setOpenId(event.eventId)}
                      onToggle={() => void cycleState(event)}
                      busy={busy}
                    />
                  ),
                )}
              </div>
            );
          })}
        </div>
      </Card>

      <WeeklyDigestCard today={today} />

      {open !== null && (
        <EventPanel
          event={open}
          members={members}
          busy={busy}
          onClose={() => setOpenId(null)}
          onEdit={() => {
            setEditLine(
              formatQuickAddLine({
                startDate: open.startDate,
                endDate: open.endDate,
                startTime: open.startTime,
                endTime: open.endTime,
                title: open.title,
                kind: open.kind,
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

function EventChip({
  event, continued, mine, onOpen, onToggle, busy,
}: {
  event: TeamEventView;
  continued: boolean;
  mine: boolean;
  onOpen: () => void;
  onToggle: () => void;
  busy: boolean;
}) {
  const style = STATE_STYLE[event.state];
  const jiraWarn = event.jiraState === "failed" || event.jiraState === "unknown";

  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      title={`${event.title}${event.assigneeName === "" ? "" : ` · 담당 ${event.assigneeName}`}`}
      style={{
        display: "flex", alignItems: "center", gap: 4, marginBottom: 3,
        padding: "2px 5px", borderRadius: 4, cursor: "pointer",
        background: style.bg,
        border: mine ? `1px solid ${style.fg}` : "1px solid transparent",
        opacity: event.state === "canceled" ? 0.65 : 1,
      }}
    >
      <button
        type="button"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        title="예정 → 진행 → 완료"
        style={{
          width: 9, height: 9, borderRadius: "50%", flexShrink: 0, padding: 0,
          border: `1.5px solid ${style.fg}`,
          background: event.state === "done" ? style.fg : "transparent",
          cursor: busy ? "default" : "pointer",
        }}
      />
      <span style={{
        fontSize: 11, color: style.fg, whiteSpace: "nowrap",
        overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0,
        textDecoration: event.state === "canceled" ? "line-through" : "none",
      }}>
        {continued && "↳ "}
        {event.startTime !== "" && !continued && (
          <span style={{ fontFamily: MONO_STACK, marginRight: 3 }}>{event.startTime}</span>
        )}
        {event.title}
      </span>
      {jiraWarn && (
        <span title={event.jiraError} style={{ fontSize: 10, color: COLOR.waitUs, flexShrink: 0 }}>
          !
        </span>
      )}
    </div>
  );
}
