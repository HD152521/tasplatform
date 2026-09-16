"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { CveViewRow } from "../../lib/queries.ts";
import { Badge, COLOR, Card, MONO_STACK, RADIUS, formatStamp } from "../ui.tsx";

/** CVSS 심각도별 색. 사용하는 색의 의미를 앱 전체와 맞춘다. */
function severityTone(s: string): { fg: string; bg: string } {
  switch (s.toUpperCase()) {
    case "CRITICAL": return { fg: "#7a1c12", bg: "#fde3df" };
    case "HIGH": return { fg: COLOR.waitUs, bg: COLOR.waitUsBg };
    case "MEDIUM": return { fg: COLOR.warn, bg: COLOR.warnBg };
    case "LOW": return { fg: COLOR.ok, bg: COLOR.okBg };
    default: return { fg: COLOR.muted, bg: COLOR.ground };
  }
}

const ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNKNOWN: 4 };

export function CveList({ cves }: { cves: CveViewRow[] }) {
  const [product, setProduct] = useState("all");
  const [minSeverity, setMinSeverity] = useState("all");
  const [query, setQuery] = useState("");

  const products = useMemo(() => {
    const seen = new Map<string, number>();
    for (const c of cves) seen.set(c.product, (seen.get(c.product) ?? 0) + 1);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]);
  }, [cves]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cves
      .filter((c) => {
        if (product !== "all" && c.product !== product) return false;
        if (minSeverity !== "all") {
          const limit = ORDER[minSeverity] ?? 4;
          if ((ORDER[c.severity] ?? 4) > limit) return false;
        }
        if (q === "") return true;
        return c.cve_id.toLowerCase().includes(q)
          || c.summary.toLowerCase().includes(q)
          || c.summary_ko.toLowerCase().includes(q);
      })
      .sort((a, b) => {
        const bySeverity = (ORDER[a.severity] ?? 4) - (ORDER[b.severity] ?? 4);
        if (bySeverity !== 0) return bySeverity;
        return b.published.localeCompare(a.published);
      });
  }, [cves, product, minSeverity, query]);

  return (
    <>
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center", marginBottom: 16 }}>
        <Chip label="전체" count={cves.length} active={product === "all"} onClick={() => setProduct("all")} />
        {products.map(([name, count]) => (
          <Chip key={name} label={name} count={count}
                active={product === name} onClick={() => setProduct(name)} />
        ))}

        <select
          value={minSeverity} onChange={(e) => setMinSeverity(e.target.value)}
          style={{
            marginLeft: "auto", padding: "7px 11px", fontSize: 12.5,
            border: `1px solid ${COLOR.field}`, borderRadius: RADIUS.control,
            background: COLOR.surface, fontFamily: "inherit",
          }}
        >
          <option value="all">모든 심각도</option>
          <option value="CRITICAL">Critical 만</option>
          <option value="HIGH">High 이상</option>
          <option value="MEDIUM">Medium 이상</option>
        </select>

        <input
          value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="CVE 번호 · 내용 검색"
          style={{
            minWidth: 220, padding: "8px 12px", fontSize: 13,
            border: `1px solid ${COLOR.field}`, borderRadius: RADIUS.control,
            background: COLOR.surface, fontFamily: "inherit", outline: "none",
          }}
        />
      </div>

      {shown.length === 0 ? (
        <Card style={{ padding: 44, textAlign: "center", color: COLOR.faint, fontSize: 13 }}>
          조건에 맞는 취약점이 없습니다.
        </Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {shown.map((c) => {
            const tone = severityTone(c.severity);
            const critical = c.severity === "CRITICAL";
            return (
              <Card key={`${c.cve_id}-${c.product}`} style={{
                padding: "14px 18px",
                borderLeft: critical ? `3px solid ${tone.fg}` : "3px solid transparent",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 6, flexWrap: "wrap" }}>
                  <Link href={`/cves/${c.cve_id}`} style={{
                    fontFamily: MONO_STACK, fontSize: 13, fontWeight: 600,
                    color: COLOR.accent, textDecoration: "none",
                  }}>
                    {c.cve_id}
                  </Link>
                  <Badge fg={tone.fg} bg={tone.bg} strong={critical}>
                    {c.severity}
                    {c.score !== null ? ` ${c.score}` : ""}
                  </Badge>
                  <span style={{ fontSize: 12, color: COLOR.muted }}>{c.product}</span>
                  <span style={{
                    marginLeft: "auto", fontFamily: MONO_STACK,
                    fontSize: 11.5, color: COLOR.faint, whiteSpace: "nowrap",
                  }}>
                    {formatStamp(Date.parse(c.published))}
                  </span>
                </div>

                <p style={{
                  margin: 0, fontSize: 13, lineHeight: 1.7, color: COLOR.body,
                  display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}>
                  {c.summary_ko === "" ? c.summary : c.summary_ko}
                </p>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}

function Chip({
  label, count, active, onClick,
}: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={{
      display: "inline-flex", alignItems: "center", gap: 7,
      padding: "6px 11px 6px 13px", fontSize: 12.5,
      fontWeight: active ? 600 : 400,
      color: active ? "#ffffff" : COLOR.ink,
      background: active ? COLOR.accent : COLOR.surface,
      border: `1px solid ${active ? COLOR.accent : COLOR.field}`,
      borderRadius: RADIUS.pill, cursor: "pointer", fontFamily: "inherit",
    }}>
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
