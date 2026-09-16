"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { ProductComponent } from "../../lib/queries.ts";
import { COLOR, Card, RADIUS, controlStyle } from "../ui.tsx";

/**
 * SR 작성 도우미.
 *
 * 포털의 실제 작성 폼과 같은 필드·같은 순서. 여기서 채운 뒤 포털에 옮겨적는다.
 * 글자수 제한은 포털이 표시하는 실제 값이다.
 *
 * Company / Group Site Id / Issue Type 은 매번 같은 값이라 고정으로 둔다.
 * (실측: 케이스 37075952 의 partyName, partySiteNumber, flex 의 Issue Type)
 */

/**
 * 매번 같은 값. 그리고 지금은 바꿀 수 없는 값.
 *
 * Product / Component 는 payload 에 ID 로 들어가는데(subCategoryId, compId)
 * 그 선택지 목록을 아직 확보하지 못했다. 고를 수 있는 것처럼 보여주면
 * 고른 것과 다른 값이 등록되므로, 템플릿 값 그대로 고정해서 보여준다.
 */
const FIXED = {
  company: "NONGHYUP BANK (NH BANK)",
  siteId: "15588968",
  issueType: "Technical",
} as const;

const SEVERITIES = [
  "Critical - P1",
  "High - P2",
  "Medium - P3",
  "Low - P4",
] as const;

const SUBJECT_LIMIT = 700;

/** 실측한 포털 우선순위 id (request_type_priority_mapping) */
const PRIORITY_ID: Record<string, number> = {
  "Critical - P1": 1, "High - P2": 2, "Medium - P3": 3, "Low - P4": 4,
};

interface Draft {
  serial: string;
  release: string;
  severity: string;
  subject: string;
  content: string;
}

export function DraftForm({ combos }: { combos: ProductComponent[] }) {
  const [d, setD] = useState<Draft>({
    serial: "",
    release: "",
    severity: "Medium - P3",
    subject: "",
    content: "",
  });
  const [copied, setCopied] = useState<string | null>(null);
  // 실제로 써 본 조합만 고를 수 있다. Product 를 바꾸면 Component 도 그 제품 것으로 바뀐다.
  const products = useMemo(() => {
    const seen = new Map<number, { id: number; name: string; used: number }>();
    for (const c of combos) {
      const prev = seen.get(c.productId);
      seen.set(c.productId, {
        id: c.productId, name: c.productName, used: (prev?.used ?? 0) + c.used,
      });
    }
    return [...seen.values()].sort((a, b) => b.used - a.used);
  }, [combos]);
  const [productId, setProductId] = useState<number>(products[0]?.id ?? 0);
  const componentsOf = useMemo(
    () => combos.filter((c) => c.productId === productId).sort((a, b) => b.used - a.used),
    [combos, productId],
  );
  const [componentId, setComponentId] = useState<number>(0);
  const activeComponent =
    componentsOf.find((c) => c.componentId === componentId) ?? componentsOf[0];
  const productName = products.find((p) => p.id === productId)?.name ?? "";
  const componentName = activeComponent?.componentName ?? "";
  const [stage, setStage] = useState<"write" | "confirm">("write");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ id: string; num: number } | null>(null);
  const router = useRouter();

  const set = (k: keyof Draft) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
  ) => setD((prev) => ({ ...prev, [k]: e.target.value }));

  const missing = useMemo(() => {
    const need: Array<[string, string]> = [
      ["Prod Release", d.release],
      ["Product", productName], ["Component", componentName],
      ["Subject", d.subject], ["Content", d.content],
    ];
    return need.filter(([, v]) => v.trim() === "").map(([k]) => k);
  }, [d, productName, componentName]);

  async function submit(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: d.subject,
          content: d.content,
          priorityId: PRIORITY_ID[d.severity] ?? 3,
          productId,
          componentId: activeComponent?.componentId,
        }),
      });
      const data = (await response.json()) as {
        ok?: boolean; message?: string; requestId?: number; requestIdFormatted?: string;
      };
      if (data.ok === true && typeof data.requestId === "number") {
        setCreated({ id: data.requestIdFormatted ?? String(data.requestId), num: data.requestId });
        router.refresh();
        return;
      }
      setError(data.message ?? "등록에 실패했습니다.");
      setStage("write");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("write");
    } finally {
      setBusy(false);
    }
  }

  async function copy(label: string, text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      setCopied(null);
    }
  }

  if (created !== null) {
    return (
      <Card style={{
        padding: "24px 26px", background: COLOR.okBg, borderColor: "#b9e6cd",
        color: COLOR.ok, lineHeight: 1.8,
      }}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>케이스를 등록했습니다</div>
        <div style={{ fontSize: 14, marginTop: 6 }}>
          {`케이스 번호 ${created.id}`}
        </div>
        <div style={{ fontSize: 13, marginTop: 4, opacity: 0.9 }}>
          다음 수집 때 목록에 나타납니다.
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <a href={`/cases/${created.num}`} style={{ ...controlStyle, textDecoration: "none", padding: "8px 14px" }}>
            케이스 열기
          </a>
          <button type="button" onClick={() => { setCreated(null); setStage("write"); }}
                  style={{ ...controlStyle, padding: "8px 14px" }}>
            새로 작성
          </button>
        </div>
      </Card>
    );
  }

  return (
    <div style={{ display: "flex", gap: 22, alignItems: "flex-start" }}>
      <Card style={{ flex: 1, minWidth: 0, padding: "20px 22px 6px" }}>
        <SectionTitle>케이스 속성</SectionTitle>

        {/* 매번 같은 값 — 입력받지 않고 그대로 쓴다 */}
        <div style={{
          display: "flex", gap: 22, flexWrap: "wrap",
          padding: "12px 14px", marginBottom: 18,
          background: COLOR.ground, borderRadius: RADIUS.control,
        }}>
          {[
            ["Company", FIXED.company],
            ["Group Site Id", FIXED.siteId],
            ["Issue Type", FIXED.issueType],
          ].map(([k, v]) => (
            <div key={k}>
              <div style={{ fontSize: 11, color: COLOR.faint, marginBottom: 3 }}>{k}</div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{v}</div>
            </div>
          ))}
          <div style={{ marginLeft: "auto", alignSelf: "center", fontSize: 11, color: COLOR.faint }}>
            항상 같은 값이라 고정해 두었습니다
          </div>
        </div>

        <Row>
          <Field label="Product" required hint="지금까지 케이스를 올린 제품만 고를 수 있습니다">
            <select
              value={productId}
              onChange={(e) => { setProductId(Number(e.target.value)); setComponentId(0); }}
              style={inputStyle}
            >
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Component" required hint="선택한 제품에서 실제로 쓰인 것만 나옵니다">
            <select
              value={activeComponent?.componentId ?? 0}
              onChange={(e) => setComponentId(Number(e.target.value))}
              style={inputStyle}
            >
              {componentsOf.map((c) => (
                <option key={c.componentId} value={c.componentId}>
                  {c.componentName}
                </option>
              ))}
            </select>
          </Field>
        </Row>

        <Row>
          <Field label="Prod Release" required hint="예: TPCF 10.4, Ops Manager 3.0">
            <input value={d.release} onChange={set("release")} placeholder="TPCF 10.4" style={inputStyle} />
          </Field>
          <Field label="Severity" required hint="P3 이 일반 문의입니다">
            <select value={d.severity} onChange={set("severity")} style={inputStyle}>
              {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
        </Row>

        <Field label="Serial Number" hint="비워도 됩니다">
          <input value={d.serial} onChange={set("serial")} placeholder="" style={inputStyle} />
        </Field>

        <SectionTitle>내용</SectionTitle>

        <Field label="Subject" required count={d.subject.length} limit={SUBJECT_LIMIT}
               hint="대괄호로 제품·버전을 앞에 붙이는 것이 팀 관행입니다">
          <input value={d.subject} onChange={set("subject")} maxLength={SUBJECT_LIMIT}
                 placeholder="[TPCF 10.4] Resource sizing inquiry for enabling OpenTelemetry"
                 style={inputStyle} />
        </Field>

        <Field label="Content" required
               hint="배경과 질문을 함께 적으시면 됩니다. 질문에 번호를 붙이면 답변도 나뉘어 옵니다.">
          <textarea value={d.content} onChange={set("content")} rows={14}
                    placeholder={"Background\nTPCF 10.4로 업그레이드한 뒤 Tanzu Hub 연동을 검토 중입니다.\n\nQuestions\n1. OTel 활성화 시 VM당 추가 CPU/메모리 권고치가 있습니까?\n2. 리소스 증설이 필요합니까?"}
                    style={{ ...inputStyle, lineHeight: 1.7 }} />
        </Field>

      </Card>

      <aside style={{ width: 400, flexShrink: 0, position: "sticky", top: 26 }}>
        <Card style={{ padding: "16px 18px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 13 }}>
            <b style={{ fontSize: 13 }}>포털에 옮겨적을 값</b>
            {missing.length > 0 && (
              <span style={{ fontSize: 11, color: COLOR.waitUs }}>{`필수 ${missing.length}개 남음`}</span>
            )}
          </div>

          <div style={{ marginBottom: 15 }}>
            {[
              ["Company", FIXED.company],
              ["Group Site Id", FIXED.siteId],
              ["Issue Type", FIXED.issueType],
              ["Prod Release", d.release],
              ["Severity", d.severity],
              ["Product", productName],
              ["Component", componentName],
              ["Serial Number", d.serial],
            ].map(([k, v]) => (
              <div key={k} style={{
                display: "flex", gap: 10, fontSize: 12, padding: "5px 0",
                borderBottom: `1px solid ${COLOR.divider}`,
              }}>
                <span style={{ width: 112, flexShrink: 0, color: COLOR.faint }}>{k}</span>
                <span style={{
                  minWidth: 0, color: v === "" ? "#c7ccd4" : COLOR.body,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {v === "" ? "—" : v}
                </span>
              </div>
            ))}
          </div>

          <PreviewBlock label="Subject" text={d.subject}
                        copied={copied === "Subject"} onCopy={() => copy("Subject", d.subject)} />
          <PreviewBlock label="Content" text={d.content} tall
                        copied={copied === "Content"} onCopy={() => copy("Content", d.content)} />
        </Card>

        {error !== "" && (
          <div style={{
            marginTop: 12, background: COLOR.waitUsBg, color: COLOR.waitUs,
            border: "1px solid #f3c7c2", borderRadius: RADIUS.control,
            padding: "10px 13px", fontSize: 12.5, lineHeight: 1.6,
          }}>
            {error}
          </div>
        )}

        {stage === "write" ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
            <span style={{ fontSize: 11.5, color: COLOR.faint, lineHeight: 1.5 }}>
              전송하면 Broadcom 에 케이스가 실제로 등록됩니다.
            </span>
            <button
              type="button" onClick={() => setStage("confirm")} disabled={missing.length > 0}
              style={{
                ...controlStyle, marginLeft: "auto", padding: "9px 18px", fontWeight: 600,
                color: missing.length === 0 ? "#ffffff" : COLOR.faint,
                background: missing.length === 0 ? COLOR.accent : COLOR.ground,
                borderColor: missing.length === 0 ? COLOR.accent : COLOR.field,
                cursor: missing.length === 0 ? "pointer" : "default",
              }}
            >
              SR 등록
            </button>
          </div>
        ) : (
          <div style={{ marginTop: 14 }}>
            <div style={{
              fontSize: 12, color: COLOR.warn, background: COLOR.warnBg,
              border: "1px solid #f0d69a", borderRadius: RADIUS.control,
              padding: "10px 13px", marginBottom: 11, lineHeight: 1.65,
            }}>
              위 내용으로 <b>새 케이스가 등록</b>됩니다. 담당 엔지니어가 배정되어 바로 읽습니다.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={() => setStage("write")} disabled={busy}
                      style={{ ...controlStyle, padding: "8px 14px" }}>
                고치기
              </button>
              <button
                type="button" onClick={submit} disabled={busy}
                style={{
                  ...controlStyle, marginLeft: "auto", padding: "8px 18px", fontWeight: 600,
                  color: "#ffffff",
                  background: busy ? COLOR.muted : COLOR.waitUs,
                  borderColor: busy ? COLOR.muted : COLOR.waitUs,
                  cursor: busy ? "default" : "pointer",
                }}
              >
                {busy ? "등록 중…" : "확인, 등록합니다"}
              </button>
            </div>
          </div>
        )}

        <p style={{ margin: "12px 2px 0", fontSize: 12, color: COLOR.faint, lineHeight: 1.75 }}>
          Product · Component 는 지금까지 올린 케이스에서 뽑은 목록입니다.
          한 번도 안 써 본 조합은 포털에서 직접 작성해 주세요.
        </p>
      </aside>
    </div>
  );
}

function PreviewBlock({
  label, text, copied, onCopy, tall = false,
}: { label: string; text: string; copied: boolean; onCopy: () => void; tall?: boolean }) {
  const empty = text.trim() === "";
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: COLOR.faint, letterSpacing: "0.03em" }}>
          {label}
        </span>
        <button type="button" onClick={onCopy} disabled={empty} style={{
          ...controlStyle, marginLeft: "auto", padding: "3px 9px", fontSize: 11,
          color: empty ? "#c7ccd4" : COLOR.muted,
          cursor: empty ? "default" : "pointer",
        }}>
          {copied ? "복사됨" : "복사"}
        </button>
      </div>
      <pre style={{
        margin: 0, padding: "10px 12px", fontSize: 12.5, lineHeight: 1.7,
        color: empty ? "#c7ccd4" : COLOR.body,
        background: COLOR.ground, borderRadius: RADIUS.control,
        whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit",
        maxHeight: tall ? 320 : 88, overflow: "auto",
      }}>
        {empty ? "—" : text}
      </pre>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 11px", fontSize: 13, lineHeight: 1.6,
  color: COLOR.ink, background: COLOR.surface,
  border: `1px solid ${COLOR.field}`, borderRadius: RADIUS.control,
  fontFamily: "inherit", boxSizing: "border-box", outline: "none", resize: "vertical",
  height: 38,
};

/** 한 줄에 두 칸. 각 칸이 같은 폭을 갖도록 flex-basis 0 으로 둔다. */
function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>{children}</div>;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 600, color: COLOR.faint, letterSpacing: "0.04em",
      margin: "4px 0 14px", paddingBottom: 8, borderBottom: `1px solid ${COLOR.divider}`,
    }}>
      {children}
    </div>
  );
}

/**
 * 라벨 → 입력 → 힌트 순서.
 *
 * 힌트를 입력창 위에 두면 문구 길이가 칸마다 달라 입력창 높이가 어긋난다.
 * 아래로 내리면 라벨과 입력창이 항상 같은 선에서 시작한다.
 */
function Field({
  label, hint, required = false, count, limit, children,
}: {
  label: string; hint?: string; required?: boolean;
  count?: number; limit?: number; children: React.ReactNode;
}) {
  const near = count !== undefined && limit !== undefined && count > limit * 0.9;
  return (
    <div style={{ flex: "1 1 0", minWidth: 0, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 5, height: 20, marginBottom: 6 }}>
        <label style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</label>
        {required && <span style={{ color: COLOR.waitUs, fontSize: 12 }}>*</span>}
        {count !== undefined && limit !== undefined && (
          <span style={{ marginLeft: "auto", fontSize: 11, color: near ? COLOR.warn : COLOR.faint }}>
            {`${count}/${limit}`}
          </span>
        )}
      </div>
      {children}
      {hint !== undefined && (
        <div style={{ fontSize: 11.5, color: COLOR.faint, marginTop: 5, lineHeight: 1.5 }}>
          {hint}
        </div>
      )}
    </div>
  );
}
