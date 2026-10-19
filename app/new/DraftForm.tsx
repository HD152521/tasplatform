"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { ProductComponent } from "../../lib/queries.ts";
import { clearDraft, draftKey, loadDraft, saveDraft } from "../../lib/draftStore.ts";
import {
  EMPTY_SR_DRAFT,
  hasBody,
  parseSrDraft,
  type SrDraft,
} from "../../lib/srDraft.ts";
import { writeFailureText } from "../../lib/writeFailure.ts";
import { SEVERITIES, priorityIdOf } from "../../lib/severity.ts";
import { COLOR, Card, RADIUS, controlStyle } from "../ui.tsx";
import { Select } from "../Select.tsx";
import { Composer, type ComposeMode } from "./Composer.tsx";
import { ReleasePicker, type PickedRelease } from "./ReleasePicker.tsx";
import { TrackPicker } from "./TrackPicker.tsx";
import {
  DEFAULT_TRACK, guessTrack, hasHangul, koTitleFrom, type SrTrack,
} from "../../lib/jiraSrTicket.ts";
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

/** 포털 작성 폼이 표시하는 실제 제목 길이 제한. */
const SUBJECT_LIMIT = 700;

/** SR 작성 칸은 한 곳뿐이라 대상 번호가 없다. */
const DRAFT_KEY = draftKey("new");

export function DraftForm({
  combos,
  fromCatalog = false,
}: {
  combos: ProductComponent[];
  /** 수집분이 없어 내장 목록으로 채웠는가. 힌트 문구만 달라진다. */
  fromCatalog?: boolean;
}) {
  const [d, setD] = useState<SrDraft>(EMPTY_SR_DRAFT);

  /**
   * 쓰던 내용을 브라우저에 붙잡아 둔다.
   *
   * SR 본문은 번역·정리까지 거쳐 몇 분을 들이는 글이다. 보내려는 순간 "세션이
   * 만료되었습니다" 가 뜨는 일이 있는데(공용 계정을 웹과 수집기가 같이 쓴다),
   * 세션을 고치려고 **새로고침하면 그 글이 사라졌다.**
   *
   * 첫 그림은 빈 값으로 둔다. 서버가 그린 HTML 과 처음 렌더가 다르면 React 가
   * 경고를 내고 화면이 한 번 튄다. 그래서 붙여 넣기는 마운트 뒤에 한다.
   */
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const restored = parseSrDraft(loadDraft(DRAFT_KEY));
    if (restored !== null) setD(restored);
    setLoaded(true);
  }, []);

  // 꺼내 온 **뒤부터** 저장한다. 안 그러면 첫 렌더의 빈 값이 보관해 둔 글을 덮는다
  // (복구 setState 는 다음 렌더에 반영되므로 한 박자 늦다).
  useEffect(() => {
    if (!loaded) return;
    // 알맹이(제목·본문)가 없으면 **빈 문자열로** 넘겨 자리를 비운다. JSON 을 그대로
    // 넘기면 빈 칸들만 담긴 글자가 남아, 등록 직후에도 보관해 둔 초안이 있는 것처럼
    // 자리를 차지한다(lib/draftStore.ts: 빈 글은 저장하지 않는다).
    saveDraft(DRAFT_KEY, hasBody(d) ? JSON.stringify(d) : "");
  }, [d, loaded]);
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
  /**
   * 고른 Prod Release. 글자가 아니라 **번호**를 들고 있어야 한다 — 포털이 받는 것이
   * 번호다(app/new/ReleasePicker.tsx 머리말). 고르지 않으면 null 이고, 그때는 버전을
   * 보내지 않는다.
   */
  const [release, setRelease] = useState<PickedRelease | null>(null);

  /**
   * ## Jira 티켓에 쓸 값들
   *
   * 티켓 제목·본문은 **한글이어야 한다** — 우리 팀이 목록에서 읽기 때문이다. 그런데
   * 포털에 올라가는 SR 은 영문이라(한국어로 적으면 번역해서 올린다), 번역이 입력칸을
   * 갈아끼우는 순간 한글이 사라진다. 되돌리기용으로 Composer 가 한 단계 들고 있지만
   * 그건 화면 안에서만 쓰는 값이다.
   *
   * 그래서 번역 **직전** 글을 여기 따로 붙잡아 둔다. 영문으로 바로 쓴 경우에는 한글이
   * 아예 없고, 그때는 영문으로 떨어진다(lib/jiraSrTicket.ts).
   */
  const [koOriginal, setKoOriginal] = useState("");
  const [track, setTrack] = useState<SrTrack>(DEFAULT_TRACK);
  /** 사람이 구분을 직접 골랐는가. 골랐으면 **덮어쓰지 않는다.** */
  const [trackPicked, setTrackPicked] = useState(false);
  /** 티켓 제목(한글). 비워 두면 원문 첫 줄에서 뽑는다. */
  const [titleKo, setTitleKo] = useState("");
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
    /*
     * 번역은 한국어를 영문으로 **갈아끼운다.** 그 전 글이 Jira 티켓에 쓸 한글이므로
     * 여기서 붙잡아 둔다. "정리(tidy)" 는 영문을 다듬는 것이라 한글이 아니다.
     *
     * **한글일 때만 붙잡는다.** 번역을 두 번 누르면 두 번째에는 입력칸에 영문이 들어
     * 있는데, 그걸 "한글 원문" 으로 잡으면 티켓 본문이 영문으로 떨어진다 — 티켓을
     * 한글로 쓰려는 이유가 사라진다.
     */
    if (mode === "translate" && hasHangul(d.content)) {
      setKoOriginal(d.content);
      // 제목과 구분은 **비어 있거나 아직 안 고른 경우에만** 채운다. 사람이 고른 값을
      // 번역 버튼이 덮으면, 고친 줄도 모르고 틀린 구분으로 올라간다.
      if (titleKo.trim() === "") setTitleKo(koTitleFrom(d.content));
      if (!trackPicked) setTrack(guessTrack(d.content));
    }
    try {
      const response = await fetch("/api/draft/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: d.content,
          mode,
          productName, componentName,
          // 고른 릴리스 이름을 넘긴다(AI 가 본문에 환경을 적는 데 쓴다).
          // 안 골랐으면 빈 값 — 없는 버전을 넘겨 본문에 적히게 하지 않는다.
          release: release?.releaseDesc ?? "", severity: d.severity,
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
  /** 등록 결과. Jira 티켓 결과도 함께 들고 있다 — 실패를 조용히 넘기지 않으려는 것이다. */
  const [created, setCreated] = useState<{
    id: string; num: number;
    jira?: {
      state?: string; key?: string; url?: string; message?: string;
      dropped?: string[]; linked?: boolean;
    };
  } | null>(null);
  const router = useRouter();

  const set = (k: keyof SrDraft) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
  ) => setD((prev) => ({ ...prev, [k]: e.target.value }));

  const missing = useMemo(() => {
    const need: Array<[string, string]> = [
      // 적은 글자가 아니라 **고른 번호**를 본다. 글자만 보면, 적었지만 고르지 않아
      // 전송되지 않는 상태를 "다 채웠다" 로 보여 준다 — 그게 이 버그의 모습이었다.
      ["Prod Release", release === null ? "" : "ok"],
      ["Product", productName], ["Component", componentName],
      ["Subject", d.subject], ["Content", d.content],
    ];
    return need.filter(([, v]) => v.trim() === "").map(([k]) => k);
  }, [d, productName, componentName, release]);

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
          priorityId: priorityIdOf(d.severity),
          productId,
          componentId: activeComponent?.componentId,
          // 분류(categoryId)는 보내지 않는다. 서버가 제품에서 되찾는다 —
          // 화면이 둘을 따로 보내면 한쪽만 고쳐졌을 때 짝이 어긋난다(lib/releasePair.ts).
          releaseId: release?.releaseId,
          // Jira 티켓용. 스위치가 꺼져 있으면 서버가 쓰지 않는다.
          track,
          titleKo,
          bodyKo: koOriginal,
          productName, componentName,
        }),
      });
      const data = (await response.json()) as {
        ok?: boolean; code?: string; message?: string;
        requestId?: number; requestIdFormatted?: string;
        jira?: {
          state?: string; key?: string; url?: string; message?: string;
          dropped?: string[]; linked?: boolean;
        };
      };
      if (data.ok === true && typeof data.requestId === "number") {
        setCreated({
          id: data.requestIdFormatted ?? String(data.requestId),
          num: data.requestId,
          jira: data.jira,
        });
        // 올린 뒤에는 **반드시** 지운다. 남기면 다음에 열 때 이미 올린 SR 이
        // 되살아나 같은 건을 두 번 등록하게 된다.
        clearDraft(DRAFT_KEY);
        setD(EMPTY_SR_DRAFT);
        router.refresh();
        return;
      }
      // 세션 만료면 글이 남아 있다는 사실과 되살리는 방법까지 함께 보여 준다.
      setError(writeFailureText(data, "등록에 실패했습니다."));
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

        {/*
          티켓 결과를 **반드시 보여 준다.**

          티켓 생성이 실패해도 SR 등록은 성공이다(뒤집으면 사람이 재시도해서 중복
          케이스가 생긴다). 그래서 실패는 값으로 돌아오는데, 화면이 말하지 않으면
          아무도 모른다 — 티켓이 없으면 SR 이 끝난 뒤 결과를 적을 곳도 없다.
        */}
        {created.jira?.state === "ok" && (
          <>
            <div style={{ fontSize: 13, marginTop: 6 }}>
              {"Jira 티켓 "}
              <a href={created.jira.url} target="_blank" rel="noreferrer"
                 style={{ color: COLOR.ok, fontWeight: 600 }}>
                {created.jira.key}
              </a>
              {" 을 함께 만들었습니다."}
            </div>
            {/*
              티켓은 만들었지만 **온전하지 않은** 경우를 말해 준다. 조용히 넘기면
              라벨이나 에픽이 빠진 티켓이 정상처럼 보이고, 연결이 없으면 SR 이 끝난 뒤
              자동 댓글 대상에서 빠진다.
            */}
            {(created.jira.dropped?.length ?? 0) > 0 && (
              <JiraWarn>
                {`일부 칸은 Jira 가 받지 않아 빼고 만들었습니다 — ${created.jira.dropped?.join(", ")}. `
                  + "티켓에서 직접 채워 주세요."}
              </JiraWarn>
            )}
            {created.jira.linked === false && (
              <JiraWarn>
                {"티켓은 만들었지만 이 SR 과의 연결을 저장하지 못했습니다. "
                  + "SR 이 끝난 뒤 결과가 자동으로 달리지 않습니다."}
              </JiraWarn>
            )}
          </>
        )}
        {/*
          **"모른다" 를 "실패" 와 가른다.** 타임아웃·망 오류는 티켓이 이미 만들어졌을
          수 있다. 거기에 "직접 만드세요" 라고 쓰면 티켓이 두 개 된다.
        */}
        {created.jira?.state === "unknown" && (
          <JiraWarn>
            {"Jira 티켓이 만들어졌는지 확인하지 못했습니다 — "}
            {created.jira.message ?? ""}
            {" Jira 에서 먼저 확인하세요. 바로 새로 만들면 두 개가 됩니다."}
          </JiraWarn>
        )}
        {created.jira?.state === "failed" && (
          <JiraWarn>
            {"SR 은 등록됐지만 Jira 티켓은 만들지 못했습니다 — "}
            {created.jira.message ?? "이유를 알 수 없습니다."}
            {" 티켓은 Jira 에서 직접 만들어 주세요."}
          </JiraWarn>
        )}
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
          <Field label="Prod Release" required hint="제품의 릴리스를 포털에서 찾아 고릅니다">
            <ReleasePicker productId={productId} value={release} onChange={setRelease} />
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

        {/*
          Jira 티켓에 쓸 값들. 등록과 함께 티켓이 하나 끊긴다.

          여기 적는 한글이 티켓 제목이 된다 — 포털에 올라가는 영문 제목으로는 Jira
          목록에서 무슨 일인지 읽히지 않기 때문이다. 번역 버튼을 누르면 그 직전 글에서
          제목과 구분을 미리 채워 둔다.
        */}
        <Row>
          <Field label="Jira 제목 (한글)"
                 hint="비워 두면 한글 원문 첫 줄을 씁니다. 티켓 목록에 이 글자가 보입니다">
            <input
              value={titleKo}
              onChange={(e) => setTitleKo(e.target.value)}
              placeholder="예: 노드 재시작 원인 문의"
              style={inputStyle}
            />
          </Field>
          <Field label="구분" hint="티켓 제목의 대괄호가 됩니다. 모르면 운영">
            <TrackPicker
              value={track}
              onChange={(next) => { setTrack(next); setTrackPicked(true); }}
              disabled={busy}
            />
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

/** 티켓이 온전하지 않을 때 쓰는 경고 줄. 성공 화면 안에서 쓴다. */
function JiraWarn({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      marginTop: 10, padding: "9px 12px", fontSize: 12.5, lineHeight: 1.6,
      color: COLOR.warn, background: COLOR.warnBg,
      border: "1px solid #f0d69a", borderRadius: RADIUS.control,
    }}>
      {children}
    </div>
  );
}
