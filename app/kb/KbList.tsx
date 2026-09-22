"use client";

import { useMemo, useState } from "react";
import type { KbViewRow } from "../../lib/queries.ts";
import { Badge, COLOR, Card, MONO_STACK, RADIUS, formatStamp } from "../ui.tsx";

/** 판정값별 색과 라벨. 앱 전체의 색 의미와 맞춘다(우리 일=빨강 계열). */
function verdictTone(v: string): { fg: string; bg: string; label: string } {
  switch (v) {
    case "match": return { fg: COLOR.waitUs, bg: COLOR.waitUsBg, label: "관련 있음" };
    case "maybe": return { fg: COLOR.warn, bg: COLOR.warnBg, label: "확인 필요" };
    case "no": return { fg: COLOR.muted, bg: COLOR.ground, label: "관련 없음" };
    default: return { fg: COLOR.faint, bg: COLOR.ground, label: "미판정" };
  }
}

/** 관련 있는 것부터 위로. 미판정은 관련 없음보다 위에 둔다(아직 안 본 것이므로). */
const ORDER: Record<string, number> = { match: 0, maybe: 1, "": 2, no: 3 };

/** lastmod 는 ISO 라 파싱되지만, 형식이 달라질 수 있어 실패하면 원문을 그대로 쓴다. */
function stamp(raw: string): string {
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? raw : formatStamp(ms);
}

export function KbList({ rows }: { rows: KbViewRow[] }) {
  const [product, setProduct] = useState("all");
  const [verdict, setVerdict] = useState("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<number | null>(null);

  const products = useMemo(() => {
    const seen = new Map<string, number>();
    for (const r of rows) {
      // matched 는 "TAS / Cloud Foundry, RabbitMQ" 처럼 여러 개가 들어온다.
      for (const p of r.matched.split(",").map((s) => s.trim()).filter((s) => s !== "")) {
        seen.set(p, (seen.get(p) ?? 0) + 1);
      }
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => {
        if (product !== "all" && !r.matched.includes(product)) return false;
        if (verdict !== "all" && r.verdict !== verdict) return false;
        if (q === "") return true;
        return r.title.toLowerCase().includes(q)
          || r.issue.toLowerCase().includes(q)
          || r.verdict_why.toLowerCase().includes(q);
      })
      .sort((a, b) => {
        const byVerdict = (ORDER[a.verdict] ?? 2) - (ORDER[b.verdict] ?? 2);
        return byVerdict !== 0 ? byVerdict : b.article_id - a.article_id;
      });
  }, [rows, product, verdict, query]);

  return (
    <>
      <div style={{
        display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center", marginBottom: 16,
      }}>
        <Chip label="전체" count={rows.length} active={product === "all"}
              onClick={() => setProduct("all")} />
        {products.map(([name, count]) => (
          <Chip key={name} label={name} count={count}
                active={product === name} onClick={() => setProduct(name)} />
        ))}

        <select
          value={verdict} onChange={(e) => setVerdict(e.target.value)}
          style={{
            marginLeft: "auto", padding: "7px 11px", fontSize: 12.5,
            border: `1px solid ${COLOR.field}`, borderRadius: RADIUS.control,
            background: COLOR.surface, fontFamily: "inherit",
          }}
        >
          <option value="all">모든 판정</option>
          <option value="match">관련 있음</option>
          <option value="maybe">확인 필요</option>
          <option value="">미판정</option>
          <option value="no">관련 없음</option>
        </select>

        <input
          value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="제목 · 증상 검색"
          style={{
            minWidth: 200, flex: "1 1 200px", padding: "8px 12px", fontSize: 13,
            border: `1px solid ${COLOR.field}`, borderRadius: RADIUS.control,
            background: COLOR.surface, fontFamily: "inherit", outline: "none",
          }}
        />
      </div>

      {shown.length === 0 ? (
        <Card style={{ padding: 44, textAlign: "center", color: COLOR.faint, fontSize: 13 }}>
          조건에 맞는 문서가 없습니다.
        </Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {shown.map((r) => {
            const tone = verdictTone(r.verdict);
            const expanded = open === r.article_id;
            return (
              <Card key={r.article_id} style={{
                padding: "14px 18px",
                borderLeft: r.verdict === "match" ? `3px solid ${tone.fg}` : "3px solid transparent",
              }}>
                <div style={{
                  display: "flex", alignItems: "center", gap: 9, marginBottom: 6, flexWrap: "wrap",
                }}>
                  <Badge fg={tone.fg} bg={tone.bg} strong={r.verdict === "match"}>
                    {tone.label}
                  </Badge>
                  <span style={{ fontSize: 12, color: COLOR.muted }}>{r.matched}</span>
                  <a
                    href={r.url} target="_blank" rel="noreferrer"
                    style={{
                      fontFamily: MONO_STACK, fontSize: 11.5, color: COLOR.accent,
                      textDecoration: "none",
                    }}
                  >
                    {r.article_id}
                  </a>
                  <span style={{
                    marginLeft: "auto", fontFamily: MONO_STACK,
                    fontSize: 11.5, color: COLOR.faint, whiteSpace: "nowrap",
                  }}>
                    {stamp(r.lastmod)}
                  </span>
                </div>

                <a href={r.url} target="_blank" rel="noreferrer" style={{
                  display: "block", fontSize: 13.5, fontWeight: 600, lineHeight: 1.6,
                  color: COLOR.ink, textDecoration: "none", marginBottom: 5,
                }}>
                  {r.title}
                </a>

                {r.verdict_why !== "" && (
                  <p style={{ margin: "0 0 6px", fontSize: 12.5, lineHeight: 1.7, color: tone.fg }}>
                    {r.verdict_why}
                  </p>
                )}

                <p style={{
                  margin: 0, fontSize: 12.5, lineHeight: 1.7, color: COLOR.body,
                  display: expanded ? "block" : "-webkit-box",
                  WebkitLineClamp: expanded ? "none" : 2, WebkitBoxOrient: "vertical",
                  overflow: "hidden", whiteSpace: "pre-line",
                }}>
                  {r.issue === "" ? "(증상 섹션이 비어 있습니다)" : r.issue}
                </p>

                {expanded && (
                  <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
                    <Section title="Environment" body={r.environment} />
                    <Section title="Cause" body={r.cause} />
                    <Section title="Resolution" body={r.resolution} />
                    <div style={{ fontSize: 11, color: COLOR.faint, whiteSpace: "pre-line" }}>
                      {`제품 태그: ${r.products.split("\n").join(", ")}`}
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : r.article_id)}
                  style={{
                    marginTop: 8, padding: 0, border: "none", background: "none",
                    fontSize: 11.5, color: COLOR.accent, cursor: "pointer", fontFamily: "inherit",
                  }}
                >
                  {expanded ? "접기" : "원인·조치 보기"}
                </button>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}

function Section({ title, body }: { title: string; body: string }) {
  if (body.trim() === "") return null;
  return (
    <div style={{ background: COLOR.ground, borderRadius: RADIUS.control, padding: "10px 13px" }}>
      <div style={{
        fontSize: 10.5, fontWeight: 600, color: COLOR.faint,
        letterSpacing: "0.04em", marginBottom: 5,
      }}>
        {title}
      </div>
      <div style={{
        fontSize: 12.5, lineHeight: 1.7, color: COLOR.body, whiteSpace: "pre-line",
      }}>
        {body}
      </div>
    </div>
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
