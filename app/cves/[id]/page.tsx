import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { getCve } from "../../../lib/queries.ts";
import { Badge, COLOR, Card, MONO_STACK, formatStamp } from "../../ui.tsx";
import { Summary } from "./Summary.tsx";

export const dynamic = "force-dynamic";

function severityTone(s: string): { fg: string; bg: string } {
  switch (s.toUpperCase()) {
    case "CRITICAL": return { fg: "#7a1c12", bg: "#fde3df" };
    case "HIGH": return { fg: COLOR.waitUs, bg: COLOR.waitUsBg };
    case "MEDIUM": return { fg: COLOR.warn, bg: COLOR.warnBg };
    case "LOW": return { fg: COLOR.ok, bg: COLOR.okBg };
    default: return { fg: COLOR.muted, bg: COLOR.ground };
  }
}

/** 공격 조건을 한 문장으로. 담당자가 제일 먼저 알아야 할 것. */
function riskSentence(r: {
  attack_vector: string; privileges_required: string; user_interaction: string;
}): string | null {
  if (r.attack_vector === "") return null;
  const remote = r.attack_vector === "NETWORK";
  const noAuth = r.privileges_required === "NONE";
  const noClick = r.user_interaction === "NONE";
  if (remote && noAuth && noClick) return "네트워크에서 인증 없이, 사용자 조작 없이 공격 가능합니다.";
  if (remote && noAuth) return "네트워크에서 인증 없이 공격 가능하나, 사용자 조작이 필요합니다.";
  if (remote) return "네트워크 경로이나 권한 또는 사용자 조작이 필요합니다.";
  return "원격 공격 경로는 아닙니다.";
}

const LABEL: Record<string, string> = {
  NETWORK: "네트워크", ADJACENT_NETWORK: "인접 네트워크", LOCAL: "로컬", PHYSICAL: "물리적 접근",
  NONE: "없음", LOW: "낮음", HIGH: "높음", REQUIRED: "필요", PARTIAL: "일부", COMPLETE: "전체",
};

function ko(v: string): string {
  if (v === "") return "-";
  return LABEL[v] ?? v;
}

export default async function CveDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const rows = getCve(decodeURIComponent(id));
  if (rows.length === 0) notFound();

  const c = rows[0]!;
  const tone = severityTone(c.severity);
  const risk = riskSentence(c);
  const exposed = c.attack_vector === "NETWORK" && c.privileges_required === "NONE";

  let refs: Array<{ url: string; source: string; tags: string[] }> = [];
  let affected: string[] = [];
  try { refs = JSON.parse(c.references_json) as typeof refs; } catch { refs = []; }
  try { affected = JSON.parse(c.affected_json) as string[]; } catch { affected = []; }

  return (
    <>
      <Link href="/cves" style={{ fontSize: 13, color: COLOR.accent, textDecoration: "none" }}>
        ← 보안 공지
      </Link>

      <header style={{ margin: "14px 0 22px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 9, flexWrap: "wrap" }}>
          <h1 style={{
            fontFamily: MONO_STACK, fontSize: 22, fontWeight: 700,
            margin: 0, letterSpacing: "-0.01em",
          }}>
            {c.cve_id}
          </h1>
          <Badge fg={tone.fg} bg={tone.bg} strong>
            {c.score === null ? c.severity : `${c.severity} ${c.score}`}
          </Badge>
          {rows.map((r) => (
            <Badge key={r.product} fg={COLOR.muted} bg={COLOR.ground}>{r.product}</Badge>
          ))}
        </div>

        <div style={{ display: "flex", gap: 14, fontSize: 12, color: COLOR.muted, flexWrap: "wrap" }}>
          <span>{`발행 ${formatStamp(Date.parse(c.published))}`}</span>
          {c.modified !== "" && (
            <>
              <span style={{ color: "#d6dae0" }}>·</span>
              <span>{`수정 ${formatStamp(Date.parse(c.modified))}`}</span>
            </>
          )}
          {c.cwe !== "" && (
            <>
              <span style={{ color: "#d6dae0" }}>·</span>
              <span>{c.cwe}</span>
            </>
          )}
        </div>
      </header>

      {risk !== null && (
        <Card style={{
          padding: "14px 17px", marginBottom: 16,
          background: exposed ? COLOR.waitUsBg : COLOR.ground,
          borderColor: exposed ? "#f3c7c2" : COLOR.line,
        }}>
          <div style={{
            fontSize: 13.5, fontWeight: 600, lineHeight: 1.6,
            color: exposed ? COLOR.waitUs : COLOR.ink,
          }}>
            {risk}
          </div>
        </Card>
      )}

      <div style={{ display: "flex", gap: 22, alignItems: "flex-start" }}>
        <section style={{ flex: 1, minWidth: 0 }}>
          <Summary original={c.summary} korean={c.summary_ko} />

          {affected.length > 0 && (
            <Card style={{ padding: "18px 20px", marginBottom: 14 }}>
              <SectionLabel>{`영향 받는 제품·버전 (${affected.length})`}</SectionLabel>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {affected.map((a) => (
                  <div key={a} style={{
                    fontFamily: MONO_STACK, fontSize: 11.5, color: COLOR.body,
                    padding: "6px 9px", background: COLOR.ground, borderRadius: 6,
                    wordBreak: "break-all",
                  }}>
                    {a}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* 원문은 긁어오지 않고 링크만 건다. 사이트마다 구조가 달라 깨지기 쉽다. */}
          <Card style={{ padding: "18px 20px" }}>
            <SectionLabel>참고 링크</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {refs.map((r) => (
                <a key={r.url} href={r.url} target="_blank" rel="noreferrer" style={{
                  fontSize: 13, color: COLOR.accent, textDecoration: "none",
                  wordBreak: "break-all", lineHeight: 1.6,
                }}>
                  {r.url}
                  {r.tags.length > 0 && (
                    <span style={{ color: COLOR.faint, fontSize: 11 }}>
                      {`  (${r.tags.join(", ")})`}
                    </span>
                  )}
                </a>
              ))}
              <a href={c.url} target="_blank" rel="noreferrer" style={{
                fontSize: 13, color: COLOR.accent, textDecoration: "none",
                wordBreak: "break-all", lineHeight: 1.6,
              }}>
                {c.url}
                <span style={{ color: COLOR.faint, fontSize: 11 }}>{"  (NVD 원문)"}</span>
              </a>
            </div>
          </Card>
        </section>

        <aside style={{ width: 286, flexShrink: 0 }}>
          <Card style={{ padding: "18px 18px 8px" }}>
            <SectionLabel>공격 조건</SectionLabel>
            <Fact label="공격 경로" value={ko(c.attack_vector)} />
            <Fact label="공격 복잡도" value={ko(c.attack_complexity)} />
            <Fact label="권한 필요" value={ko(c.privileges_required)} highlight={c.privileges_required === "NONE"} />
            <Fact label="사용자 조작" value={ko(c.user_interaction)} highlight={c.user_interaction === "NONE"} />

            <div style={{ height: 8 }} />
            <SectionLabel>영향</SectionLabel>
            <Fact label="기밀성" value={ko(c.impact_c)} highlight={c.impact_c === "HIGH"} />
            <Fact label="무결성" value={ko(c.impact_i)} highlight={c.impact_i === "HIGH"} />
            <Fact label="가용성" value={ko(c.impact_a)} highlight={c.impact_a === "HIGH"} />

            {c.vector !== "" && (
              <div style={{
                marginTop: 10, paddingTop: 12, paddingBottom: 10,
                borderTop: `1px solid ${COLOR.divider}`,
                fontFamily: MONO_STACK, fontSize: 10.5, color: COLOR.faint,
                wordBreak: "break-all", lineHeight: 1.5,
              }}>
                {c.vector}
              </div>
            )}
          </Card>
        </aside>
      </div>
    </>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 600, color: COLOR.faint,
      letterSpacing: "0.04em", marginBottom: 11,
    }}>
      {children}
    </div>
  );
}

function Fact({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 9 }}>
      <span style={{ width: 78, flexShrink: 0, color: COLOR.faint, fontSize: 12 }}>{label}</span>
      <span style={{
        fontSize: 13,
        color: highlight ? COLOR.waitUs : COLOR.ink,
        fontWeight: highlight ? 600 : 400,
      }}>
        {value}
      </span>
    </div>
  );
}
