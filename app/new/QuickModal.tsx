"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_SEVERITY,
  SEVERITIES,
  priorityIdOf,
} from "../../lib/severity.ts";
import { COLOR, Notice, RADIUS, controlStyle } from "../ui.tsx";
import { Select } from "../Select.tsx";
import { ReleasePicker, type PickedRelease } from "./ReleasePicker.tsx";
import { TrackPicker } from "./TrackPicker.tsx";
import { DEFAULT_TRACK, guessTrack, koTitleFrom, type SrTrack } from "../../lib/jiraSrTicket.ts";

/**
 * 간단히 올리기.
 *
 * 한 칸에 한국어로 적으면 영문 제목·본문과 Product · Component 를 전부 만들어 보여주고,
 * 한 번 더 눌러 등록한다.
 *
 * ## 왜 바로 올리지 않나
 *
 * 등록은 **고객사 벤더로 나가는 외부 쓰기**다. 되돌리려면 포털에 들어가 사정해야 하는데,
 * 그 포털에 안 들어가려고 만든 도구다. 그래서 결과를 한 화면에 보여주고 한 번 누르게
 * 한다 — 고를 것이 없으니 "간단히" 는 그대로다.
 *
 * 보여주는 것에 두 가지가 꼭 들어간다.
 *   - **못 채운 자리**(`missing`). 초안에 `(to be confirmed)` 가 남았는데 그대로 올리면
 *     빈칸인 SR 이 벤더에게 간다.
 *   - **기본값으로 떨어졌는지**(`fallback`). 조용히 기본 제품으로 올리면 사람은 AI 가
 *     고른 줄 안다.
 *
 * ## 심각도만 입력받는다
 *
 * 나머지는 정해 주지만 심각도는 사람이 둔다. 대응 우선순위가 달라지는 값이라 모델이
 * 짐작할 일이 아니다. 기본 P3 은 작성 폼과 같다.
 */

interface Ready {
  readonly subject: string;
  readonly content: string;
  readonly missing: string[];
  readonly productId: number;
  readonly productName: string;
  readonly componentId: number;
  readonly componentName: string;
  /** 글에서 찾은 릴리스. 못 찾으면 0 / 빈 문자열이고, 버전 없이 등록된다. */
  readonly releaseId: number;
  readonly releaseDesc: string;
  readonly reason: string;
  readonly fallback: boolean;
}

const text2 = (v: unknown): string => (typeof v === "string" ? v : "");
const posInt = (v: unknown): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0;

/**
 * 서버 응답을 **검사해서** 받는다. 모양이 어긋나면 null.
 *
 * `?? 0` 으로 메우면 productId 0 으로 등록을 시도한다. 그러면 실패하기는 하는데
 * 원인이 포털 응답까지 가서야 드러나므로, 여기서 끊고 작성 폼으로 안내한다.
 * 제목·본문·제품·컴포넌트는 **없으면 올릴 수 없는 값**이라 하나라도 빠지면 거부한다.
 */
function readReady(body: Record<string, unknown>): Ready | null {
  const subject = text2(body.subject).trim();
  const content = text2(body.content).trim();
  const productId = posInt(body.productId);
  const componentId = posInt(body.componentId);
  if (subject === "" || content === "" || productId === 0 || componentId === 0) return null;

  const missing = Array.isArray(body.missing)
    ? body.missing.map(text2).filter((m) => m !== "")
    : [];

  return {
    subject,
    content,
    missing,
    productId,
    productName: text2(body.productName),
    componentId,
    componentName: text2(body.componentName),
    // 버전은 **없어도 올릴 수 있다.** 그래서 제품·컴포넌트처럼 거부 조건에 넣지 않는다.
    releaseId: posInt(body.releaseId),
    releaseDesc: text2(body.releaseDesc),
    reason: text2(body.reason).trim(),
    // 모르면 **폴백으로 본다.** 경고를 띄우고 마는 쪽이, 조용히 "AI 가 골랐다" 고
    // 보여 주는 쪽보다 낫다.
    fallback: body.fallback !== false,
  };
}

export function QuickModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [severity, setSeverity] = useState<string>(DEFAULT_SEVERITY);
  const [ready, setReady] = useState<Ready | null>(null);
  /**
   * 올릴 때 쓸 릴리스.
   *
   * 서버가 글에서 집어 주면 그걸로 시작하고, 못 집었으면 null 이다. null 이면
   * **올리기를 막고** 이 자리에서 고르게 한다. 전에는 "버전 없이 등록됩니다" 라고
   * 적어 두고 실제로는 템플릿 값(다른 제품의 10.4.2)으로 올라갔다 — 화면이 거짓말을
   * 한 셈이다(lib/releasePair.ts 머리말).
   */
  const [release, setRelease] = useState<PickedRelease | null>(null);
  /*
   * Jira 티켓용. 여기서는 **사람이 적은 글이 곧 한글 원문**이라 따로 붙잡아 둘 것이
   * 없다(작성 폼은 번역이 입력칸을 갈아끼워서 직전 값을 보관해야 한다).
   * 제목과 구분은 그 글에서 미리 채워 두고, 확인 화면에서 고칠 수 있게 한다.
   */
  const [track, setTrack] = useState<SrTrack>(DEFAULT_TRACK);
  const [titleKo, setTitleKo] = useState("");
  const [busy, setBusy] = useState<"compose" | "create" | null>(null);
  const [error, setError] = useState("");
  /** 등록 결과. Jira 티켓 결과도 함께 — 실패를 조용히 넘기지 않는다. */
  const [created, setCreated] = useState<{
    id: string; num: number;
    jira?: {
      state?: string; key?: string; url?: string; message?: string;
      dropped?: string[]; linked?: boolean;
    };
  } | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    box.current?.focus();
  }, []);

  // Esc 로 닫는다. 올리는 중에는 닫지 않는다 — 요청은 이미 나갔고, 창을 닫아도
  // 등록은 진행된다. 닫히면 사람은 올라갔는지 모른 채 남는다.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && busy === null) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function compose(): Promise<void> {
    setError("");
    setBusy("compose");
    try {
      const response = await fetch("/api/draft/quick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text, severity }),
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok || body.ok !== true) {
        setError(text2(body.message) || `정리하지 못했습니다 (HTTP ${response.status}).`);
        return;
      }
      const parsed = readReady(body);
      if (parsed === null) {
        // 여기 오면 서버와 화면이 어긋난 것이다. `?? 0` 으로 메우면 productId 0 으로
        // 등록을 시도하고, 그 실패 원인을 포털 응답에서 되짚어야 한다.
        setError("정리 결과를 읽지 못했습니다. 작성 폼에서 직접 올려주세요.");
        return;
      }
      setReady(parsed);
      // 서버가 글에서 집어 준 버전. 못 집었으면 null 이고, 그러면 아래에서 고르게 한다.
      setRelease(parsed.releaseId > 0
        ? { releaseId: parsed.releaseId, releaseDesc: parsed.releaseDesc }
        : null);
      // 적은 글에서 제목·구분을 미리 골라 둔다. 확정이 아니라 기본값 제안이다.
      setTitleKo(koTitleFrom(text));
      setTrack(guessTrack(text));
    } catch (e) {
      setError(e instanceof Error ? e.message : "정리하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  /** 등록은 기존 경로로 보낸다 — 세션 재시도와 감사 로그가 그쪽에 있다. */
  async function submit(): Promise<void> {
    if (ready === null) return;
    setError("");
    setBusy("create");
    try {
      const response = await fetch("/api/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: ready.subject,
          content: ready.content,
          priorityId: priorityIdOf(severity),
          productId: ready.productId,
          componentId: ready.componentId,
          // 고른 값만 보낸다. 없으면 서버가 400 으로 거절한다 — 아래 버튼이 이미
          // 막고 있지만, 막는 곳이 한 군데면 그 한 군데가 깨질 때 조용히 뚫린다.
          releaseId: release?.releaseId ?? 0,
          // 적은 글이 그대로 한글 원문이다.
          track,
          titleKo,
          bodyKo: text,
          productName: ready.productName,
          componentName: ready.componentName,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const requestId = posInt(body.requestId);
      if (!response.ok || body.ok !== true || requestId === 0) {
        setError(text2(body.message) || `등록하지 못했습니다 (HTTP ${response.status}).`);
        return;
      }
      setCreated({
        id: text2(body.requestIdFormatted) || String(requestId),
        num: requestId,
        jira: body.jira as {
          state?: string; key?: string; url?: string; message?: string;
          dropped?: string[]; linked?: boolean;
        } | undefined,
      });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "등록하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="간단히 올리기"
      style={{
        position: "fixed", inset: 0, zIndex: 50,
        background: "rgba(15, 18, 24, 0.55)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: "6vh 16px", overflowY: "auto",
      }}
      // 바깥을 눌러 닫는다. 올리는 중에는 안 닫는다(위 Esc 와 같은 이유).
      onClick={(event) => {
        if (event.target === event.currentTarget && busy === null) onClose();
      }}
    >
      <div style={{
        width: "100%", maxWidth: 720, background: COLOR.surface,
        borderRadius: RADIUS.card, border: `1px solid ${COLOR.line}`,
        padding: 22, boxShadow: "0 18px 50px rgba(0,0,0,0.28)",
      }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, letterSpacing: "-0.01em" }}>
            간단히 올리기
          </h2>
          <span style={{ fontSize: 12, color: COLOR.muted }}>
            제목 · 본문 · Product · Component 를 알아서 정합니다
          </span>
        </div>

        {created !== null ? (
          <div style={{ marginTop: 16 }}>
            <Notice tone="ok">
              {`${created.id} 로 등록했습니다.`}
              {created.jira?.state === "ok" && created.jira.key !== undefined
                ? ` Jira 티켓 ${created.jira.key} 도 만들었습니다.`
                : ""}
            </Notice>
            {/*
              티켓 실패를 **반드시 말한다.** SR 은 올라갔고 티켓만 실패한 상태라,
              화면이 조용하면 아무도 모른다 — SR 이 끝난 뒤 결과를 적을 곳이 없다.
            */}
            {(created.jira?.dropped?.length ?? 0) > 0 && (
              <Notice tone="warn">
                {`일부 칸은 Jira 가 받지 않아 빼고 만들었습니다 — ${created.jira?.dropped?.join(", ")}.`}
              </Notice>
            )}
            {created.jira?.state === "ok" && created.jira.linked === false && (
              <Notice tone="warn">
                {"티켓은 만들었지만 이 SR 과의 연결을 저장하지 못했습니다. "
                  + "SR 이 끝난 뒤 결과가 자동으로 달리지 않습니다."}
              </Notice>
            )}
            {/* "모른다" 에 "직접 만드세요" 라고 쓰면 티켓이 두 개 된다. */}
            {created.jira?.state === "unknown" && (
              <Notice tone="warn">
                {"Jira 티켓이 만들어졌는지 확인하지 못했습니다 — "}
                {created.jira.message ?? ""}
                {" Jira 에서 먼저 확인하세요. 바로 새로 만들면 두 개가 됩니다."}
              </Notice>
            )}
            {created.jira?.state === "failed" && (
              <Notice tone="warn">
                {"Jira 티켓은 만들지 못했습니다 — "}
                {created.jira.message ?? "이유를 알 수 없습니다."}
                {" Jira 에서 직접 만들어 주세요."}
              </Notice>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <a href={`/cases/${created.num}`} style={primary}>케이스 보기</a>
              <button type="button" onClick={onClose} style={ghost}>닫기</button>
            </div>
          </div>
        ) : ready === null ? (
          <>
            <p style={{ margin: "10px 0 8px", fontSize: 13, color: COLOR.muted }}>
              증상·환경·이미 해본 것을 한국어로 적어주세요. 메모처럼 적어도 됩니다.
            </p>
            <textarea
              ref={box}
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={10}
              placeholder={"예) 은행 운영 TAS 에서 어제 저녁부터 앱 두 개가 계속 crash 남.\n"
                + "cf logs 보면 OOM 같고, 메모리 쿼터는 안 건드렸음. Diego cell 재시작은 해봤음."}
              style={{ ...controlStyle, width: "100%", minHeight: 180, resize: "vertical", lineHeight: 1.6 }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
              <span style={{ fontSize: 13, color: COLOR.muted }}>심각도</span>
              <Select
                value={severity}
                options={SEVERITIES.map((s) => ({ value: s, label: s }))}
                onChange={(value) => setSeverity(String(value))}
                ariaLabel="심각도"
              />
              <span style={{ flex: 1 }} />
              <button type="button" onClick={onClose} style={ghost} disabled={busy !== null}>
                취소
              </button>
              <button
                type="button"
                onClick={() => void compose()}
                disabled={busy !== null || text.trim() === ""}
                style={primary}
              >
                {busy === "compose" ? "정리하는 중…" : "정리하기"}
              </button>
            </div>
          </>
        ) : (
          <div style={{ marginTop: 14 }}>
            {ready.fallback && (
              <Notice tone="warn">
                {"어떤 Product · Component 인지 정하지 못해 가장 많이 쓴 조합으로 두었습니다. "
                  + "맞는지 보고, 아니면 취소하고 작성 폼에서 골라주세요."}
              </Notice>
            )}
            {ready.missing.length > 0 && (
              <Notice tone="warn">
                {`원문에 없어 못 채운 것이 있습니다 — ${ready.missing.join(" / ")}. `
                  + "그대로 올리면 Broadcom 이 되묻습니다."}
              </Notice>
            )}

            <Row label="Product">{ready.productName}</Row>
            <Row label="Component">{ready.componentName}</Row>
            {/*
              버전을 집었으면 보여 주고, 못 집었으면 **여기서 고르게 한다.**

              전에는 "버전 없이 등록됩니다" 라고 적어 두고 실제로는 템플릿 값(다른
              제품의 10.4.2)으로 올라갔다. 화면이 거짓말을 한 셈이고, 그 사실은 답변이
              오고 나서야 드러났다. 지금은 고르지 않으면 올리기가 잠긴다.
            */}
            {release !== null && ready.releaseId > 0 ? (
              <Row label="Prod Release">{`${release.releaseDesc} (글에서 찾음)`}</Row>
            ) : (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, color: COLOR.muted, marginBottom: 4 }}>
                  Prod Release
                </div>
                <ReleasePicker
                  productId={ready.productId}
                  value={release}
                  onChange={setRelease}
                />
                {release === null && (
                  <div style={{ fontSize: 11.5, color: COLOR.warn, marginTop: 2 }}>
                    글에서 버전을 찾지 못했습니다. 골라야 올릴 수 있습니다.
                  </div>
                )}
              </div>
            )}
            {ready.reason !== "" && <Row label="고른 이유">{ready.reason}</Row>}

            {/*
              Jira 티켓 제목에 쓸 한글. 적은 글 첫 줄로 채워 두고 고칠 수 있게 한다 —
              포털에 올라가는 영문 제목으로는 티켓 목록에서 무슨 일인지 읽히지 않는다.
            */}
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 12, color: COLOR.muted, marginBottom: 4 }}>
                Jira 제목 (한글)
              </div>
              <input
                value={titleKo}
                onChange={(e) => setTitleKo(e.target.value)}
                aria-label="Jira 제목"
                style={{
                  width: "100%", boxSizing: "border-box", padding: "8px 11px",
                  fontSize: 13, fontFamily: "inherit", color: COLOR.ink,
                  border: `1px solid ${COLOR.field}`, borderRadius: RADIUS.control,
                  outline: "none",
                }}
              />
            </div>
            <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ fontSize: 12, color: COLOR.muted }}>구분</div>
              <TrackPicker value={track} onChange={setTrack} disabled={busy !== null} />
            </div>
            <Row label="심각도">{severity}</Row>
            <Row label="제목">{ready.subject}</Row>

            <div style={{ marginTop: 12, fontSize: 12, color: COLOR.muted }}>본문</div>
            <pre style={{
              margin: "6px 0 0", padding: 12, background: COLOR.ground,
              border: `1px solid ${COLOR.line}`, borderRadius: RADIUS.control,
              fontSize: 12.5, lineHeight: 1.65, whiteSpace: "pre-wrap",
              maxHeight: 280, overflowY: "auto",
            }}>{ready.content}</pre>

            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button
                type="button"
                onClick={() => { setReady(null); setRelease(null); setError(""); }}
                style={ghost}
                disabled={busy !== null}
              >
                다시 적기
              </button>
              <span style={{ flex: 1 }} />
              <button type="button" onClick={onClose} style={ghost} disabled={busy !== null}>
                취소
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                // 버전을 고르지 않으면 올릴 수 없다. 서버도 거절하지만, 거절을
                // 보고 나서야 알게 하면 사람은 왜 막혔는지 모른다.
                disabled={busy !== null || release === null}
                style={release === null ? { ...primary, opacity: 0.45, cursor: "default" } : primary}
              >
                {busy === "create" ? "올리는 중…" : "올리기"}
              </button>
            </div>
          </div>
        )}

        {error !== "" && (
          <div style={{ marginTop: 12 }}>
            <Notice tone="error">{error}</Notice>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 10, padding: "6px 0", fontSize: 13, lineHeight: 1.6 }}>
      <span style={{ width: 76, flexShrink: 0, color: COLOR.muted }}>{label}</span>
      <span style={{ flex: 1, wordBreak: "break-word" }}>{children}</span>
    </div>
  );
}

const primary: React.CSSProperties = {
  ...controlStyle,
  width: "auto", padding: "8px 16px", cursor: "pointer",
  background: COLOR.accent, color: "#fff", border: "none",
  fontWeight: 600, textDecoration: "none", display: "inline-block",
};

const ghost: React.CSSProperties = {
  ...controlStyle,
  width: "auto", padding: "8px 14px", cursor: "pointer", background: "transparent",
};
