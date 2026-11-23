"use client";

/**
 * SR 목록 — 이 도구에서 제일 많이 보는 화면.
 *
 * ## 한 가지만 묻는 화면이다
 *
 * "무엇이 **내 차례**인가." 그래서 새 답변이 온 줄에만 색을 쓴다. 상태 배지는 모든
 * 줄에 있으니 색으로 경쟁하면 안 되고, 눈이 먼저 잡아야 하는 것은 왼쪽 빨간 선이다.
 *
 * ## 줄은 격자다
 *
 * 줄마다 그림자·라운드를 주면 목록이 울퉁불퉁해져 눈이 줄을 못 따라간다. 헤어라인
 * 하나로 나누고 각을 세운다(RADIUS.cell = 0). 날짜·건수는 전부 tabular 숫자다 —
 * 세로로 흔들리면 비교가 안 된다.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import type { CaseListRow } from "../lib/queries.ts";
import {
  Badge,
  COLOR,
  Card,
  Chip,
  Empty,
  MONO_STACK,
  SPACE,
  TEXT,
  Tab,
  WEIGHT,
  formatStamp,
  inputStyle,
  statusColors,
} from "./ui.tsx";

const UNREAD = "__unread__";

type SortKey = "updated" | "created";

const SORTS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: "updated", label: "업데이트순" },
  { key: "created", label: "생성순" },
];

export function CaseList({
  cases, showUnread = true, closed = false,
}: { cases: CaseListRow[]; showUnread?: boolean; closed?: boolean }) {
  const [filter, setFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("updated");

  const statuses = useMemo(() => {
    const seen = new Map<string, number>();
    for (const row of cases) seen.set(row.status, (seen.get(row.status) ?? 0) + 1);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]);
  }, [cases]);

  const unreadCount = cases.filter((c) => c.unread_replies > 0).length;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    // 답변이 온 건은 순서를 바꾸지 않고 붉은 표시로만 구분한다 — 순서가 흔들리면
    // "어제 보던 그 자리" 를 잃는다.
    const matched = cases.filter((row) => {
      if (filter === UNREAD && row.unread_replies === 0) return false;
      if (filter !== "all" && filter !== UNREAD && row.status !== filter) return false;
      if (q === "") return true;
      return (
        row.subject.toLowerCase().includes(q) ||
        row.request_id_formatted.includes(q) ||
        row.party_name.toLowerCase().includes(q) ||
        row.description_text.toLowerCase().includes(q)
      );
    });

    const key = sort === "created" ? "created_on_ms" : "last_updated_ms";
    return [...matched].sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0));
  }, [cases, filter, query, sort]);

  return (
    <>
      {/* ── 도구줄 ─────────────────────────────────────── */}
      <div style={{
        display: "flex", gap: SPACE.sm, flexWrap: "wrap", alignItems: "center",
        marginBottom: SPACE.lg,
      }}>
        <Chip label="전체" count={cases.length} active={filter === "all"} onClick={() => setFilter("all")} />
        {showUnread && unreadCount > 0 && (
          <Chip
            label="새 답변"
            count={unreadCount}
            active={filter === UNREAD}
            tone="danger"
            onClick={() => setFilter(UNREAD)}
          />
        )}
        {statuses.map(([name, count]) => (
          <Chip key={name} label={name} count={count} active={filter === name} onClick={() => setFilter(name)} />
        ))}

        <span style={{ flex: 1 }} />

        <div style={{ display: "flex", gap: SPACE.xxs }}>
          {SORTS.map(({ key, label }) => (
            <Tab key={key} active={sort === key} onClick={() => setSort(key)}>{label}</Tab>
          ))}
        </div>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="번호 · 제목 · 고객사 · 본문"
          aria-label="케이스 검색"
          style={{ ...inputStyle, width: 244 }}
        />
      </div>

      {shown.length === 0 ? (
        <Empty>
          {cases.length === 0
            ? "아직 수집된 케이스가 없습니다."
            : "조건에 맞는 케이스가 없습니다. 필터나 검색어를 지워 보세요."}
        </Empty>
      ) : (
        <Card flush>
          {shown.map((row, i) => (
            <CaseRow
              key={row.request_id}
              row={row}
              closed={closed}
              last={i === shown.length - 1}
            />
          ))}
        </Card>
      )}
    </>
  );
}

function CaseRow({ row, closed, last }: { row: CaseListRow; closed: boolean; last: boolean }) {
  const tone = statusColors(row.status);
  const unread = row.unread_replies > 0;

  return (
    <Link
      href={`/cases/${row.request_id}`}
      style={{ textDecoration: "none", color: "inherit", display: "block" }}
    >
      <div style={{
        display: "flex", alignItems: "flex-start", gap: SPACE.md,
        padding: `${SPACE.md}px ${SPACE.lg}px ${SPACE.md}px 0`,
        borderBottom: last ? "none" : `1px solid ${COLOR.divider}`,
        // 내 차례인 줄만 바탕을 들어 준다. 아주 옅게 — 색이 세지면 줄이 카드처럼 떠서
        // 목록으로 안 읽힌다.
        background: unread ? COLOR.waitUsBg : COLOR.surface,
      }}>
        {/*
          왼쪽 선. 이 화면에서 가장 먼저 눈에 걸려야 하는 신호다.
          자리는 항상 차지하고(색만 바뀐다) 줄의 시작선이 흔들리지 않게 한다.
        */}
        <div style={{
          width: 3, alignSelf: "stretch", flexShrink: 0,
          background: unread ? COLOR.waitUs : "transparent",
        }} />

        <div style={{ flex: 1, minWidth: 0, paddingLeft: SPACE.md }}>
          <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm, marginBottom: SPACE.xxs }}>
            <span style={{
              fontFamily: MONO_STACK, fontSize: TEXT.micro, color: COLOR.faint,
              fontVariantNumeric: "tabular-nums",
            }}>
              {row.request_id_formatted}
            </span>
            <Badge fg={tone.fg} bg={tone.bg}>{row.status}</Badge>
            {row.confluence_url !== null && row.confluence_url !== "" && (
              <Badge fg={COLOR.ok} bg={COLOR.okBg}>SR 올림</Badge>
            )}
            {unread && (
              <Badge fg={COLOR.waitUs} bg={COLOR.waitUsBg} strong>
                새 답변 {row.unread_replies}
              </Badge>
            )}
          </div>

          <div style={{
            fontSize: TEXT.lead, lineHeight: 1.45, letterSpacing: "-0.005em",
            fontWeight: unread ? WEIGHT.semibold : WEIGHT.medium,
            color: COLOR.ink,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {row.subject}
          </div>

          <div style={{
            display: "flex", alignItems: "center", gap: SPACE.sm, marginTop: SPACE.xs,
            fontSize: TEXT.small, color: COLOR.muted, minWidth: 0,
          }}>
            <span style={{ fontWeight: WEIGHT.medium, color: COLOR.body, flexShrink: 0 }}>
              {row.party_name}
            </span>
            <span style={{ color: COLOR.line, flexShrink: 0 }}>·</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {row.category}
            </span>
          </div>
        </div>

        <div style={{ textAlign: "right", flexShrink: 0, paddingLeft: SPACE.lg, minWidth: 158 }}>
          <DateLine label="등록" value={formatStamp(row.created_on_ms)} />
          <DateLine
            label={closed ? "종료" : "갱신"}
            value={formatStamp(row.last_updated_ms)}
            highlight={unread}
          />
          <div style={{
            fontSize: TEXT.micro, color: COLOR.faint, marginTop: SPACE.xs,
            fontVariantNumeric: "tabular-nums",
          }}>
            대화 {row.thread_count} · 답변 {row.reply_count}
          </div>
        </div>
      </div>
    </Link>
  );
}

function DateLine({
  label, value, highlight = false,
}: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{
      display: "flex", alignItems: "baseline", justifyContent: "flex-end", gap: SPACE.xs,
      fontSize: TEXT.small, whiteSpace: "nowrap", marginBottom: 2,
    }}>
      <span style={{ fontSize: TEXT.micro, color: COLOR.faint }}>{label}</span>
      <span style={{
        fontFamily: MONO_STACK, fontVariantNumeric: "tabular-nums",
        color: highlight ? COLOR.waitUs : COLOR.muted,
        fontWeight: highlight ? WEIGHT.semibold : WEIGHT.normal,
      }}>
        {value}
      </span>
    </div>
  );
}
