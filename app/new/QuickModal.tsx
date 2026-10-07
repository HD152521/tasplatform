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
  const [busy, setBusy] = useState<"compose" | "create" | null>(null);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ id: string; num: number } | null>(null);
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
        }),
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const requestId = posInt(body.requestId);
      if (!response.ok || body.ok !== true || requestId === 0) {
        setError(text2(body.message) || `등록하지 못했습니다 (HTTP ${response.status}).`);
        return;
      }
      setCreated({ id: text2(body.requestIdFormatted) || String(requestId), num: requestId });
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
            <Notice tone="ok">{`${created.id} 로 등록했습니다.`}</Notice>
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
            {ready.reason !== "" && <Row label="고른 이유">{ready.reason}</Row>}
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
                onClick={() => { setReady(null); setError(""); }}
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
                disabled={busy !== null}
                style={primary}
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
