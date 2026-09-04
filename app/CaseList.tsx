"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { CaseListRow } from "../lib/queries.ts";
import { Badge, COLOR, Card, MONO_STACK, RADIUS, formatStamp, statusColors } from "./ui.tsx";

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
    // 답변이 온 건은 순서를 바꾸지 않고 붉은 표시로만 구분한다.
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
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center", marginBottom: 16 }}>
        <Chip label="전체" count={cases.length} active={filter === "all"} onClick={() => setFilter("all")} />
        {showUnread && unreadCount > 0 && (
          <Chip
            label="새 답변 있는 케이스" count={unreadCount}
            active={filter === UNREAD} tone={COLOR.waitUs}
            onClick={() => setFilter(UNREAD)}
          />
        )}
        {statuses.map(([name, count]) => (
          <Chip key={name} label={name} count={count} active={filter === name} onClick={() => setFilter(name)} />
        ))}

        <div style={{
          marginLeft: "auto", display: "flex", border: `1px solid ${COLOR.field}`,
          borderRadius: RADIUS.control, overflow: "hidden", background: COLOR.surface,
        }}>
          {SORTS.map(({ key, label }) => (
            <button
              key={key} type="button" onClick={() => setSort(key)}
              style={{
                padding: "7px 12px", fontSize: 12.5, border: "none", cursor: "pointer",
                fontFamily: "inherit",
                fontWeight: sort === key ? 600 : 400,
                color: sort === key ? COLOR.ink : COLOR.muted,
                background: sort === key ? "#eef1f6" : "transparent",
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <input
          value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="번호 · 제목 · 고객사 · 본문"
          style={{
            minWidth: 230, padding: "8px 12px", fontSize: 13,
            border: `1px solid ${COLOR.field}`, borderRadius: RADIUS.control,
            background: COLOR.surface, fontFamily: "inherit", outline: "none",
          }}
        />
      </div>

      {shown.length === 0 ? (
        <Card style={{ padding: 44, textAlign: "center", color: COLOR.faint, fontSize: 13 }}>
          조건에 맞는 케이스가 없습니다.
        </Card>
      ) : (
        <Card style={{ overflow: "hidden" }}>
          {shown.map((row, i) => {
            const tone = statusColors(row.status);
            const unread = row.unread_replies > 0;
            return (
              <Link key={row.request_id} href={`/cases/${row.request_id}`}
                    style={{ textDecoration: "none", color: "inherit", display: "block" }}>
                <div style={{
                  display: "flex", alignItems: "flex-start", gap: 14, padding: "15px 18px",
                  borderBottom: i === shown.length - 1 ? "none" : `1px solid ${COLOR.divider}`,
                  background: unread ? "#fffdfd" : COLOR.surface,
                }}>
                  <div style={{
                    width: 3, alignSelf: "stretch", borderRadius: 2, flexShrink: 0,
                    background: unread ? COLOR.waitUs : "transparent",
                  }} />

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 4 }}>
                      <span style={{ fontFamily: MONO_STACK, fontSize: 11, color: COLOR.faint }}>
                        {row.request_id_formatted}
                      </span>
                      <Badge fg={tone.fg} bg={tone.bg}>{row.status}</Badge>
                      {unread && (
                        <Badge fg={COLOR.waitUs} bg={COLOR.waitUsBg} strong>
                          새 답변 {row.unread_replies}
                        </Badge>
                      )}
                    </div>

                    <div style={{
                      fontSize: 14, lineHeight: 1.45, letterSpacing: "-0.005em",
                      fontWeight: unread ? 600 : 500,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {row.subject}
                    </div>

                    <div style={{
                      display: "flex", alignItems: "center", gap: 12, marginTop: 5,
                      fontSize: 12, color: COLOR.muted,
                    }}>
                      <span style={{ fontWeight: 500, color: "#4b5563" }}>{row.party_name}</span>
                      <span style={{ color: "#d6dae0" }}>·</span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {row.category}
                      </span>
                    </div>
                  </div>

                  <div style={{ textAlign: "right", flexShrink: 0, paddingLeft: 18, minWidth: 158 }}>
                    <DateLine label="등록" value={formatStamp(row.created_on_ms)} />
                    <DateLine
                      label={closed ? "종료" : "갱신"}
                      value={formatStamp(row.last_updated_ms)}
                      highlight={unread}
                    />
                    <div style={{ fontSize: 11, color: COLOR.faint, marginTop: 5 }}>
                      대화 {row.thread_count} · 답변 {row.reply_count}
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </Card>
      )}
    </>
  );
}

function DateLine({
  label, value, highlight = false,
}: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{
      display: "flex", alignItems: "baseline", justifyContent: "flex-end", gap: 6,
      fontSize: 12, whiteSpace: "nowrap", marginBottom: 2,
    }}>
      <span style={{ fontSize: 11, color: COLOR.faint }}>{label}</span>
      <span style={{
        fontFamily: MONO_STACK, fontVariantNumeric: "tabular-nums",
        color: highlight ? COLOR.waitUs : COLOR.muted,
        fontWeight: highlight ? 600 : 400,
      }}>
        {value}
      </span>
    </div>
  );
}

function Chip({
  label, count, active, onClick, tone,
}: { label: string; count: number; active: boolean; onClick: () => void; tone?: string }) {
  const color = tone ?? COLOR.accent;
  return (
    <button
      type="button" onClick={onClick}
      style={{
        display: "inline-flex", alignItems: "center", gap: 7,
        padding: "6px 11px 6px 13px", fontSize: 13,
        fontWeight: active ? 600 : 400,
        color: active ? "#ffffff" : COLOR.ink,
        background: active ? color : COLOR.surface,
        border: `1px solid ${active ? color : COLOR.field}`,
        borderRadius: RADIUS.pill, cursor: "pointer", fontFamily: "inherit",
      }}
    >
      {label}
      <span style={{
        fontFamily: MONO_STACK, fontSize: 11,
        color: active ? "rgba(255,255,255,.75)" : COLOR.faint,
      }}>
        {count}
      </span>
    </button>
  );
}
