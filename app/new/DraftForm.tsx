"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { ProductComponent } from "../../lib/queries.ts";
import { COLOR, Card, RADIUS, controlStyle } from "../ui.tsx";
import { Select } from "../Select.tsx";
import { Composer, type ComposeMode } from "./Composer.tsx";
import { SubmitBar } from "./SubmitBar.tsx";

/**
 * SR 작성.
 *
 * 포털의 실제 작성 폼과 같은 필드·같은 순서다. 글자수 제한도 포털이 표시하는 실제 값이다.
 * **여기서 바로 등록된다** — /api/create 가 포털에 보낸다. 손으로 옮겨적던 시절의
 * "포털에 옮겨적을 값" 사이드바는 걷어냈다(app/new/SubmitBar.tsx 머리말 참고).
 *
 * 화면은 세 덩어리다: 케이스 속성 → 내용(Composer) → 등록 바(SubmitBar).
 */

/**
 * 매번 같은 값이라 입력받지 않고 그대로 쓴다.
 * (실측: 케이스 37075952 의 partyName, partySiteNumber, flex 의 Issue Type)
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

export function DraftForm({
  combos,
  fromCatalog = false,
}: {
  combos: ProductComponent[];
  /** 수집분이 없어 내장 목록으로 채웠는가. 힌트 문구만 달라진다. */
  fromCatalog?: boolean;
}) {
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
  /** 돌고 있는 작업. 없으면 null. */
  const [composing, setComposing] = useState<ComposeMode | null>(null);
  const [composeError, setComposeError] = useState("");
  /** 원문에 없어 담당자가 채워야 할 것들. */
  const [gaps, setGaps] = useState<string[]>([]);

  /**
   * 본문을 그 자리에서 바꾼다.
   *   translate 한국어 → 영어 + 팀 양식
   *   tidy      영어 그대로 두고 모양만
   * 되돌리기는 Composer 가 직전 값을 들고 있다.
   */
  async function compose(mode: ComposeMode): Promise<void> {
    setComposing(mode);
    setComposeError("");
    try {
      const response = await fetch("/api/draft/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: d.content,
          mode,
          productName, componentName,
          release: d.release, severity: d.severity,
          // 이미 제목을 적어 뒀으면 그대로 둔다.
          subject: d.subject,
        }),
      });
      const data = (await response.json()) as {
        ok?: boolean; message?: string; subject?: string; content?: string; missing?: string[];
      };
      if (data.ok !== true || typeof data.content !== "string") {
        setComposeError(data.message ?? `정리에 실패했습니다 (HTTP ${response.status}).`);
        return;
      }
      setD((prev) => ({
        ...prev,
        content: data.content ?? "",
        // 제목은 비어 있을 때만 채운다. 담당자가 적어 둔 것을 덮지 않는다.
        subject: prev.subject.trim() === "" ? (data.subject ?? "").slice(0, SUBJECT_LIMIT) : prev.subject,
      }));
      setGaps(data.missing ?? []);
    } catch (e) {
      setComposeError(e instanceof Error ? e.message : "정리 중 오류가 발생했습니다.");
    } finally {
      setComposing(null);
    }
  }
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
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <Card style={{ padding: "20px 22px 6px" }}>
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
          <Field label="Product" required
                 hint={fromCatalog ? "실제로 SR 을 올려 본 제품 목록입니다" : "지금까지 케이스를 올린 제품만 고를 수 있습니다"}>
            <Select
              ariaLabel="Product"
              value={productId}
              options={products.map((p) => ({ value: p.id, label: p.name }))}
              onChange={(v) => { setProductId(v); setComponentId(0); }}
            />
          </Field>
          <Field label="Component" required hint="선택한 제품에서 실제로 쓰인 것만 나옵니다">
            <Select
              ariaLabel="Component"
              value={activeComponent?.componentId ?? 0}
              options={componentsOf.map((c) => ({ value: c.componentId, label: c.componentName }))}
              onChange={(v) => setComponentId(v)}
            />
          </Field>
        </Row>

        {/* 제품·컴포넌트는 이름이 길어 두 칸, 나머지 셋은 짧아 한 줄에 몰아 둔다. */}
        <Row>
          <Field label="Prod Release" required hint="예: TPCF 10.4, Ops Manager 3.0">
            <input value={d.release} onChange={set("release")} placeholder="TPCF 10.4" style={inputStyle} />
          </Field>
          <Field label="Severity" required hint="P3 이 일반 문의입니다">
            <Select
              ariaLabel="Severity"
              value={d.severity}
              options={SEVERITIES.map((s) => ({ value: s, label: s }))}
              onChange={(v) => setD((prev) => ({ ...prev, severity: v }))}
            />
          </Field>
          <Field label="Serial Number" hint="비워도 됩니다">
            <input value={d.serial} onChange={set("serial")} placeholder="" style={inputStyle} />
          </Field>
        </Row>

      </Card>



      {/* 본문은 화면 전체 폭을 쓴다. 좁은 칸에 두 개를 욱여넣으면 영문을 읽을 수 없다. */}
      <Composer
        subject={d.subject} onSubject={(v) => setD((prev) => ({ ...prev, subject: v }))}
        subjectLimit={SUBJECT_LIMIT}
        content={d.content} onContent={(v) => setD((prev) => ({ ...prev, content: v }))}
        onCompose={(mode) => void compose(mode)}
        composing={composing} error={composeError} gaps={gaps}
      />

      <SubmitBar
        missing={missing} busy={busy} stage={stage} onStage={setStage}
        onSubmit={() => void submit()} error={error}
        copied={copied === "draft"}
        onCopy={() => void copy("draft", `${d.subject}\n\n${d.content}`)}
      />
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
