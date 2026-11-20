"use client";

import { useMemo, useState } from "react";
import {
  CORPS,
  SCOPES,
  describeClassification,
  classifyTags,
  houseSummary,
  type Corp,
  type Scope,
} from "../../lib/jiraHouseStyle.ts";
import { addDays, weekdayOf } from "../../lib/quickAdd.ts";
import { COLOR, Chip, MONO_STACK, RADIUS, controlStyle } from "../ui.tsx";
import type { MemberChip } from "./CalendarBoard.tsx";
import { TokenInput } from "./TokenInput.tsx";

/** 자주 쓰는 업무 성격. 목록에 없는 것도 직접 적을 수 있다. */
const WORK_KINDS = ["점검", "작업", "장애", "회의", "교육", "휴가"] as const;

export interface EventFormValue {
  readonly title: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly scopes: readonly Scope[];
  readonly corp: Corp | null;
  readonly kind: string;
  readonly assigneeUserId: number | null;
  readonly body: string;
}

/** 저장된 일정 → 폼 초기값. 수정할 때 쓴다. */
export function formValueOf(event: {
  title: string;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  scopes: string;
  corp: string;
  kind: string;
  assigneeUserId: number | null;
  body: string;
}): EventFormValue {
  const parsed = classifyTags([
    ...event.scopes.split("/").filter((p) => p !== ""),
    ...(event.corp === "" ? [] : [event.corp]),
  ]);
  return {
    title: event.title,
    startDate: event.startDate,
    endDate: event.endDate,
    startTime: event.startTime,
    endTime: event.endTime,
    scopes: parsed.scopes,
    corp: parsed.corp,
    kind: event.kind,
    assigneeUserId: event.assigneeUserId,
    body: event.body,
  };
}

export function emptyFormValue(date: string): EventFormValue {
  return {
    title: "",
    startDate: date,
    endDate: date,
    startTime: "",
    endTime: "",
    scopes: [],
    corp: null,
    kind: "",
    assigneeUserId: null,
    body: "",
  };
}

/** 폼 값 → API 가 받는 모양. 태그는 한 줄 입력과 **같은 분류 함수**를 거친다. */
export function toPayload(v: EventFormValue): Record<string, unknown> {
  return {
    title: v.title,
    startDate: v.startDate,
    endDate: v.endDate === "" ? v.startDate : v.endDate,
    startTime: v.startTime,
    endTime: v.startTime === "" ? "" : v.endTime,
    tags: [...v.scopes, ...(v.corp === null ? [] : [v.corp]), ...(v.kind === "" ? [] : [v.kind])],
    assigneeUserId: v.assigneeUserId,
    body: v.body,
  };
}

/**
 * 칸으로 입력하는 일정 폼.
 *
 * ## 왜 한 줄 입력만으로는 모자랐나
 *
 * 한 줄은 빠르지만 **틀렸을 때 비싸다** — 날짜를 잘못 읽히면 등록한 뒤 찾아가서 고쳐야
 * 한다. 그리고 망·법인처럼 **고를 수 있는 값**은 외워서 적는 것보다 보고 고르는 쪽이
 * 정확하다. 그래서 둘을 함께 둔다: 익숙하면 한 줄, 아니면 이 폼.
 *
 * 두 경로가 **같은 분류 함수**(lib/jiraHouseStyle.ts classifyTags)를 거친다. 어떻게
 * 적었느냐에 따라 Jira 제목이 달라지면 안 된다.
 *
 * 맨 아래에 **Jira 에 올라갈 제목 그대로**를 보여 준다 — 저장 전에 확인할 수 있어야
 * "또 가서 고치는" 일이 없다.
 */
export function EventForm({
  value, members, busy, submitLabel, onChange, onSubmit, onCancel,
}: {
  value: EventFormValue;
  members: readonly MemberChip[];
  busy: boolean;
  submitLabel: string;
  onChange: (next: EventFormValue) => void;
  onSubmit: () => void;
  onCancel?: () => void;
}) {
  const [showBody, setShowBody] = useState(value.body !== "");
  const set = (patch: Partial<EventFormValue>): void => onChange({ ...value, ...patch });

  const allDay = value.startTime === "";
  const multiDay = value.endDate !== "" && value.endDate !== value.startDate;

  const jiraTitle = useMemo(
    () => houseSummary({ scopes: value.scopes, corp: value.corp, title: value.title }),
    [value.scopes, value.corp, value.title],
  );
  const classification = useMemo(
    () =>
      describeClassification(
        classifyTags([
          ...value.scopes,
          ...(value.corp === null ? [] : [value.corp]),
          ...(value.kind === "" ? [] : [value.kind]),
        ]),
      ),
    [value.scopes, value.corp, value.kind],
  );

  const assignee = members.find((m) => m.userId === value.assigneeUserId) ?? null;
  const ready = value.title.trim() !== "" && value.startDate !== "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* 제목 */}
      <Row label="제목" required>
        <input
          value={value.title}
          onChange={(e) => set({ title: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && ready) {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder="예: 10월 정기 점검"
          autoFocus
          style={{ ...controlStyle, width: "100%", cursor: "text" }}
        />
      </Row>

      {/* 날짜 */}
      <Row label="날짜">
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="date"
            value={value.startDate}
            onChange={(e) => {
              const startDate = e.target.value;
              // 시작일이 종료일을 넘어가면 종료일을 끌고 간다 — 저장 때 거절당하지 않게.
              const endDate = value.endDate !== "" && value.endDate < startDate ? startDate : value.endDate;
              set({ startDate, endDate });
            }}
            style={{ ...controlStyle, cursor: "text" }}
          />
          <span style={{ fontSize: 12, color: COLOR.faint }}>
            {value.startDate === "" ? "" : `(${weekdayOf(value.startDate)})`}
          </span>

          {multiDay ? (
            <>
              <span style={{ color: COLOR.faint }}>~</span>
              <input
                type="date"
                value={value.endDate}
                min={value.startDate}
                onChange={(e) => set({ endDate: e.target.value })}
                style={{ ...controlStyle, cursor: "text" }}
              />
              <span style={{ fontSize: 12, color: COLOR.faint }}>
                {value.endDate === "" ? "" : `(${weekdayOf(value.endDate)})`}
              </span>
              <button
                type="button"
                onClick={() => set({ endDate: value.startDate })}
                style={{ ...controlStyle, padding: "5px 9px", fontSize: 12 }}
              >
                하루로
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => set({ endDate: addDays(value.startDate, 1) })}
              style={{ ...controlStyle, padding: "5px 9px", fontSize: 12 }}
            >
              + 여러 날
            </button>
          )}
        </div>
      </Row>

      {/* 시간 */}
      <Row label="시간">
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12.5, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={allDay}
              onChange={(e) => set(e.target.checked ? { startTime: "", endTime: "" } : { startTime: "09:00", endTime: "18:00" })}
              style={{ cursor: "pointer" }}
            />
            종일
          </label>
          {!allDay && (
            <>
              <input
                type="time"
                value={value.startTime}
                onChange={(e) => set({ startTime: e.target.value })}
                style={{ ...controlStyle, cursor: "text" }}
              />
              <span style={{ color: COLOR.faint }}>~</span>
              <input
                type="time"
                value={value.endTime}
                onChange={(e) => set({ endTime: e.target.value })}
                style={{ ...controlStyle, cursor: "text" }}
              />
            </>
          )}
        </div>
      </Row>

      {/* 담당자 */}
      <Row label="담당자">
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select
            value={value.assigneeUserId === null ? "" : String(value.assigneeUserId)}
            onChange={(e) => set({ assigneeUserId: e.target.value === "" ? null : Number(e.target.value) })}
            style={{ ...controlStyle, minWidth: 160 }}
          >
            <option value="">미지정</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName === "" ? m.loginId : m.displayName}
                {m.hasJira ? "" : " (Jira 미연결)"}
              </option>
            ))}
          </select>
          {assignee !== null && !assignee.hasJira && (
            <span style={{ fontSize: 11.5, color: COLOR.warn }}>
              Jira 계정이 없어 담당자 없이 올라갑니다
            </span>
          )}
        </div>
      </Row>

      {/* 전산망 — 고를 수 있는 값은 외우지 않고 고른다 */}
      <Row label="전산망" hint="Jira 제목 앞 대괄호가 됩니다. 여럿 고를 수 있습니다.">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {SCOPES.map((scope) => {
            const on = value.scopes.includes(scope);
            return (
              <Chip
                key={scope}
                label={scope}
                active={on}
                onClick={() =>
                  set({
                    scopes: on
                      ? value.scopes.filter((x) => x !== scope)
                      : [...value.scopes, scope],
                  })
                }
              />
            );
          })}
        </div>
      </Row>

      {/* 법인 */}
      <Row label="법인" hint="Jira 상위 에픽을 고릅니다.">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Chip label="없음" active={value.corp === null} onClick={() => set({ corp: null })} />
          {CORPS.map((corp) => (
            <Chip
              key={corp}
              label={corp}
              active={value.corp === corp}
              onClick={() => set({ corp })}
            />
          ))}
        </div>
      </Row>

      {/* 업무 성격 */}
      <Row label="업무 성격" hint="Jira 라벨이 됩니다(작업지원·장애대응·내부업무).">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {WORK_KINDS.map((kind) => (
            <Chip
              key={kind}
              label={kind}
              active={value.kind === kind}
              onClick={() => set({ kind: value.kind === kind ? "" : kind })}
            />
          ))}
          <input
            value={WORK_KINDS.includes(value.kind as (typeof WORK_KINDS)[number]) ? "" : value.kind}
            onChange={(e) => set({ kind: e.target.value })}
            placeholder="직접 입력"
            style={{ ...controlStyle, width: 110, cursor: "text", fontSize: 12 }}
          />
        </div>
      </Row>

      {/* 본문 */}
      {showBody ? (
        <Row label="본문" hint="Jira 이슈 본문에 들어갑니다. @이름 을 적으면 실제 멘션이 됩니다.">
          {/* `@` 를 치면 팀원 목록이 뜬다. 고른 이름은 Jira 에서 **실제 멘션**이 된다. */}
          <TokenInput
            value={value.body}
            onChange={(body) => set({ body })}
            members={members}
            triggers={["@"]}
            multiline
            rows={4}
            placeholder="작업 내용, 확인할 것, @담당자 호출 등"
          />
        </Row>
      ) : (
        <button
          type="button"
          onClick={() => setShowBody(true)}
          style={{ ...controlStyle, alignSelf: "flex-start", fontSize: 12 }}
        >
          + 본문 쓰기 (Jira 이슈 본문 · @멘션)
        </button>
      )}

      {/* Jira 미리보기 — 저장 전에 확인할 수 있어야 "또 가서 고치는" 일이 없다 */}
      <div style={{
        background: COLOR.ground, borderRadius: RADIUS.control, padding: "10px 12px",
        fontSize: 12.5, lineHeight: 1.7,
      }}>
        <div style={{ color: COLOR.faint, fontSize: 11, fontWeight: 600, marginBottom: 3 }}>
          JIRA 에 이렇게 올라갑니다
        </div>
        <div style={{ fontFamily: MONO_STACK, color: value.title.trim() === "" ? COLOR.faint : COLOR.ink }}>
          {value.title.trim() === "" ? "제목을 입력하세요" : jiraTitle}
        </div>
        <div style={{ color: COLOR.muted, marginTop: 2 }}>{classification}</div>
      </div>

      <div style={{ display: "flex", gap: 9 }}>
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy || !ready}
          style={{
            ...controlStyle, background: COLOR.accent, color: "#fff", border: "none",
            fontWeight: 600, padding: "10px 18px",
            opacity: busy || !ready ? 0.5 : 1,
          }}
        >
          {busy ? "저장 중…" : submitLabel}
        </button>
        {onCancel !== undefined && (
          <button type="button" onClick={onCancel} disabled={busy} style={{ ...controlStyle }}>
            취소
          </button>
        )}
      </div>
    </div>
  );
}

function Row({
  label, hint, required, children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label style={{ fontSize: 12, fontWeight: 600, color: COLOR.body, display: "block", marginBottom: 5 }}>
        {label}
        {required === true && <span style={{ color: COLOR.waitUs, marginLeft: 3 }}>*</span>}
      </label>
      {hint !== undefined && (
        <p style={{ margin: "0 0 6px", fontSize: 11.5, color: COLOR.faint, lineHeight: 1.6 }}>{hint}</p>
      )}
      {children}
    </div>
  );
}

