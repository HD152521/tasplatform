"use client";

import { useCallback, useEffect, useState } from "react";
import type { EventNote, TeamEventView } from "../../lib/calendar.ts";
import {
  COLOR,
  Card,
  LEADING,
  LinkButton,
  MONO_STACK,
  RADIUS,
  SPACE,
  TEXT,
  WEIGHT,
  controlStyle,
  formatStamp,
} from "../ui.tsx";
import type { MemberChip } from "./CalendarBoard.tsx";

/**
 * 일정 상세 — 메모와 Jira 상태.
 *
 * `event_notes` 가 "누가 무슨 내용을 했는지" 적어 두는 자리이고, 그대로 주간 자동
 * 정리(S6)의 재료가 된다. 그래서 적기 쉬워야 한다 — 한 칸, Enter 로 저장.
 */
export function EventPanel({
  event, members, busy, onClose, onEditForm, onEditLine, onDelete, onChanged, onMessage,
}: {
  event: TeamEventView;
  members: readonly MemberChip[];
  busy: boolean;
  onClose: () => void;
  onEditForm: () => void;
  onEditLine: () => void;
  onDelete: () => void;
  onChanged: () => Promise<void> | void;
  onMessage: (m: { tone: "ok" | "error" | "warn"; text: string } | null) => void;
}) {
  const [notes, setNotes] = useState<readonly EventNote[]>([]);
  const [draft, setDraft] = useState("");
  const [working, setWorking] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/calendar?eventId=${event.eventId}`);
      const data = (await res.json()) as { ok?: boolean; notes?: EventNote[] };
      if (data.ok === true) setNotes(data.notes ?? []);
    } catch {
      // 메모를 못 읽어도 상세는 보여 준다.
    }
  }, [event.eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 메모 한 건을 Jira 코멘트로 올린다.
   *
   * 실패해도 서버가 목록을 돌려주므로 그대로 갈아 끼운다 — 다른 창에서 이미 올렸을
   * 때 화면의 "올림" 표시가 그 자리에서 맞춰진다.
   */
  async function sendNote(noteId: number): Promise<void> {
    setWorking(true);
    try {
      const res = await fetch("/api/calendar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "note-to-jira", eventId: event.eventId, noteId }),
      });
      const data = (await res.json()) as { ok?: boolean; message?: string; notes?: EventNote[] };
      if (data.notes !== undefined) setNotes(data.notes);
      onMessage({
        tone: data.ok === true ? "ok" : "error",
        text: data.message ?? (data.ok === true ? "올렸습니다." : "올리지 못했습니다."),
      });
    } catch (error) {
      onMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setWorking(false);
    }
  }

  async function addNote(): Promise<void> {
    if (draft.trim() === "") return;
    setWorking(true);
    try {
      const res = await fetch("/api/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "note", eventId: event.eventId, body: draft }),
      });
      const data = (await res.json()) as { ok?: boolean; message?: string; notes?: EventNote[] };
      if (data.ok === true) {
        setNotes(data.notes ?? []);
        setDraft("");
        await onChanged();
      } else {
        onMessage({ tone: "error", text: data.message ?? "메모를 남기지 못했습니다." });
      }
    } catch (error) {
      onMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setWorking(false);
    }
  }

  async function retryJira(): Promise<void> {
    setWorking(true);
    onMessage(null);
    try {
      const res = await fetch("/api/calendar/jira-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: event.eventId }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        message?: string;
        results?: Array<{ message?: string; action?: string }>;
      };
      const first = data.results?.[0];
      onMessage({
        tone: data.ok === true && first?.action !== "failed" ? "ok" : "error",
        text: first?.message ?? data.message ?? "Jira 반영을 시도했습니다.",
      });
      await onChanged();
    } catch (error) {
      onMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setWorking(false);
    }
  }

  const assigneeMember = members.find((m) => m.userId === event.assigneeUserId) ?? null;
  const period =
    event.endDate === event.startDate ? event.startDate : `${event.startDate} ~ ${event.endDate}`;
  const time =
    event.startTime === ""
      ? "종일"
      : event.endTime === ""
        ? event.startTime
        : `${event.startTime} ~ ${event.endTime}`;

  return (
    <Card style={{ padding: 20, marginBottom: 18, borderColor: COLOR.accent }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.01em" }}>
            {event.kind !== "" && (
              <span style={{
                fontSize: 11, fontWeight: 700, color: COLOR.accent,
                background: COLOR.waitThemBg, padding: "2px 7px", borderRadius: RADIUS.badge,
                marginRight: 8, verticalAlign: "middle",
              }}>
                {event.kind}
              </span>
            )}
            {event.title}
          </div>
          <div style={{ fontSize: 12.5, color: COLOR.muted, marginTop: 6, lineHeight: 1.8 }}>
            <span style={{ fontFamily: MONO_STACK }}>{period}</span> · {time}
            {event.scopes !== "" && (
              <>
                {" · 전산망 "}
                <strong>{event.scopes.split("/").join(" / ")}</strong>
              </>
            )}
            {event.corp !== "" && (
              <>
                {" · 법인 "}
                <strong>{event.corp}</strong>
              </>
            )}
            {" · 담당 "}
            {event.assigneeName === "" ? (
              <span style={{ color: COLOR.faint }}>미지정</span>
            ) : (
              <strong>{event.assigneeName}</strong>
            )}
            {event.createdByName !== "" && ` · 등록 ${event.createdByName}`}
          </div>
        </div>
        <button type="button" onClick={onClose} style={{ ...controlStyle, padding: "5px 10px", fontSize: 12 }}>
          닫기
        </button>
      </div>

      {event.body.trim() !== "" && (
        <p style={{
          margin: "14px 0 0", fontSize: 13, color: COLOR.body, lineHeight: 1.75,
          whiteSpace: "pre-wrap",
        }}>
          {event.body}
        </p>
      )}

      {/* 담당자 Jira 연결 안 됨 — 조용히 넘기지 않는다. */}
      {event.assigneeUserId !== null && assigneeMember?.hasJira === false && (
        <p style={{ margin: "12px 0 0", fontSize: 12, color: COLOR.warn, lineHeight: 1.7 }}>
          담당자의 Jira 계정이 연결되지 않아 이슈에 <strong>담당자 없이</strong> 올라갑니다
          (본문에는 이름이 적힙니다). <a href="/team" style={{ color: COLOR.warn }}>팀 화면</a>에서
          각자 Jira 계정 id 를 넣을 수 있습니다.
        </p>
      )}
      {event.assigneeUserId === null && event.assigneeLabel !== "" && (
        <p style={{ margin: "12px 0 0", fontSize: 12, color: COLOR.warn, lineHeight: 1.7 }}>
          「{event.assigneeLabel}」 을 팀원과 맞추지 못했습니다. 이름을 그대로 두고 담당자는 비웠습니다
          — 정확한 이름이나 아이디로 다시 적으면 연결됩니다.
        </p>
      )}

      {/* ── Jira ─────────────────────────────────────── */}
      <div style={{
        marginTop: 16, paddingTop: 14, borderTop: `1px solid ${COLOR.divider}`,
        display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: COLOR.body }}>Jira</span>
        {event.jiraKey !== "" ? (
          <a
            href={event.jiraUrl}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 12.5, color: COLOR.accent, fontFamily: MONO_STACK, fontWeight: 600 }}
          >
            {event.jiraKey}
          </a>
        ) : (
          <span style={{ fontSize: 12, color: COLOR.faint }}>
            {event.jiraState === "none" ? "연결 없음" : "미연결"}
          </span>
        )}
        {event.jiraState !== "ok" && event.jiraState !== "none" && (
          <span style={{ fontSize: 12, color: COLOR.waitUs }}>
            {event.jiraState === "unknown" ? "만들어졌는지 확인 중" : "실패"}
            {event.jiraTries > 0 && ` (${event.jiraTries}회 시도)`}
          </span>
        )}
        <button
          type="button"
          disabled={busy || working}
          onClick={() => void retryJira()}
          style={{ ...controlStyle, padding: "5px 10px", fontSize: 12 }}
        >
          Jira 다시 맞추기
        </button>
      </div>
      {event.jiraError !== "" && (
        <p style={{ margin: "8px 0 0", fontSize: 11.5, color: COLOR.waitUs, lineHeight: 1.7 }}>
          {event.jiraError}
        </p>
      )}

      {/* ── 메모 ─────────────────────────────────────── */}
      <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${COLOR.divider}` }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
          작업 메모 {notes.length > 0 && `${notes.length}건`}
        </div>
        <p style={{ margin: "0 0 10px", fontSize: 11.5, color: COLOR.faint, lineHeight: 1.7 }}>
          무엇을 했는지 한 줄씩 적어 두면 주간 정리에 그대로 쓰입니다. 메모는 사내에만
          남습니다 — Jira 에 알릴 것은 한 건씩 골라 올리세요(@이름 은 멘션이 됩니다).
        </p>

        {notes.map((note) => (
          <div key={note.noteId} style={{
            fontSize: TEXT.base, lineHeight: LEADING.relaxed, padding: `${SPACE.xs + 3}px 0`,
            borderTop: `1px solid ${COLOR.divider}`,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm }}>
              <span style={{ fontWeight: WEIGHT.semibold }}>
                {note.author === "" ? "(알 수 없음)" : note.author}
              </span>
              <span style={{ color: COLOR.faint, fontSize: TEXT.micro }}>
                {formatStamp(Date.parse(note.createdAt))}
              </span>
              <span style={{ flex: 1 }} />
              {/*
                **사람이 고른 메모만** Jira 로 나간다. 코멘트는 지워도 알림이 이미 간
                뒤라서 쓸 때마다 자동으로 보내지 않는다(lib/calendarJira.ts postNoteToJira).
                이미 올린 것은 버튼을 없애고 올린 시각을 보여 준다 — 두 번 올리면
                알림도 두 번 간다.
              */}
              {note.jiraPostedAt !== "" ? (
                <span
                  title={`${formatStamp(Date.parse(note.jiraPostedAt))} 에 Jira 코멘트로 올렸습니다`}
                  style={{ fontSize: TEXT.micro, color: COLOR.ok, flexShrink: 0 }}
                >
                  Jira 에 올림
                </span>
              ) : event.jiraKey === "" ? null : (
                <LinkButton onClick={() => void sendNote(note.noteId)} disabled={working}>
                  Jira 에 올리기
                </LinkButton>
              )}
            </div>
            <div style={{ color: COLOR.body, whiteSpace: "pre-wrap" }}>{note.body}</div>
          </div>
        ))}

        <div style={{ display: "flex", gap: 9, marginTop: 10 }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void addNote();
              }
            }}
            placeholder="한 줄 메모 (Enter 저장)"
            style={{ ...controlStyle, flex: 1, cursor: "text" }}
          />
          <button
            type="button"
            disabled={working || draft.trim() === ""}
            onClick={() => void addNote()}
            style={{ ...controlStyle, opacity: working || draft.trim() === "" ? 0.5 : 1 }}
          >
            메모
          </button>
        </div>
      </div>

      {/* ── 조작 ─────────────────────────────────────── */}
      <div style={{
        marginTop: 18, paddingTop: 14, borderTop: `1px solid ${COLOR.divider}`,
        display: "flex", gap: 9,
      }}>
        <button
          type="button"
          onClick={onEditForm}
          disabled={busy}
          style={{ ...controlStyle, fontWeight: 600 }}
        >
          수정
        </button>
        <button type="button" onClick={onEditLine} disabled={busy} style={{ ...controlStyle, fontSize: 12 }}>
          한 줄로 수정
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          style={{ ...controlStyle, color: COLOR.waitUs, marginLeft: "auto" }}
        >
          {event.jiraKey === "" ? "일정 삭제" : `일정 + 이슈 ${event.jiraKey} 삭제`}
        </button>
      </div>
    </Card>
  );
}
