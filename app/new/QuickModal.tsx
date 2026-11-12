"use client";

import { useEffect, useRef, useState } from "react";
import { DEFAULT_SEVERITY, SEVERITIES } from "../../lib/severity.ts";
import { COLOR, Notice, RADIUS, controlStyle } from "../ui.tsx";
import { Select } from "../Select.tsx";
import { parseQuickFill } from "../../lib/quickFill.ts";
import { useQuickFill } from "./QuickFillBus.tsx";

/**
 * 간단히 올리기 — **적는 칸 하나와 "정리하기" 버튼뿐이다.**
 *
 * 한 칸에 한국어로 메모처럼 적으면 영문 제목·본문과 Product · Component · 버전까지
 * 만들어, **아래 작성 폼에 입력된 상태로 채운다.** 이 창은 닫힌다.
 *
 * ## 왜 결과를 이 창에 보여주지 않나
 *
 * 전에는 정리 결과를 이 창에 `<pre>` 로 펼쳐 놓고 거기서 올렸다. 거기서는 **고칠 수가
 * 없었다.** 거의 맞는 글에서 한 줄만 고치고 싶어도 길이 없어서, 취소하고 작성 폼에
 * 처음부터 다시 적어야 했다. 작성 폼에는 모든 칸이 이미 입력칸으로 있으니, 결과를
 * 그쪽에 채우면 보여주기와 고치기가 한 번에 된다.
 *
 * 그래서 등록 버튼도 여기서 없앴다. 올리는 길이 작성 폼 하나로 줄어든다 — 두 군데면
 * 세션 재시도나 감사 로그 같은 것이 한쪽에만 붙는 날이 온다.
 *
 * ## 심각도만 여기서 받는다
 *
 * 대응 우선순위가 달라지는 값이라 모델이 짐작할 일이 아니고, 정리 프롬프트에 문맥으로
 * 들어간다. 채운 뒤에도 작성 폼에서 바꿀 수 있다.
 */
export function QuickModal({ onClose }: { onClose: () => void }) {
  const { publish } = useQuickFill();
  const [text, setText] = useState("");
  const [severity, setSeverity] = useState<string>(DEFAULT_SEVERITY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    box.current?.focus();
  }, []);

  // Esc 로 닫는다. 정리하는 중에는 닫지 않는다 — 7~8초가 드는 호출이고, 창이 닫히면
  // 사람은 결과가 어디로 갔는지 모른 채 남는다.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function compose(): Promise<void> {
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/draft/quick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text, severity }),
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok || body.ok !== true) {
        const message = typeof body.message === "string" ? body.message : "";
        setError(message || `정리하지 못했습니다 (HTTP ${response.status}).`);
        return;
      }
      const fill = parseQuickFill(body, text, severity);
      if (fill === null) {
        // 여기 오면 서버와 화면이 어긋난 것이다. 빈 값으로 메워 폼에 채우면, 사람은
        // 채워진 칸을 보고 올리기를 눌러 포털 응답에서야 거절당한다.
        setError("정리 결과를 읽지 못했습니다. 아래 작성 폼에서 직접 올려주세요.");
        return;
      }
      // 폼이 받아 채운다. 이 창은 할 일이 끝났다.
      publish(fill);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "정리하지 못했습니다.");
    } finally {
      setBusy(false);
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
      // 바깥을 눌러 닫는다. 정리하는 중에는 안 닫는다(위 Esc 와 같은 이유).
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
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
            제목 · 본문 · Product · Component 를 정해 아래 폼에 채웁니다
          </span>
        </div>

        <p style={{ margin: "10px 0 8px", fontSize: 13, color: COLOR.muted }}>
          증상·환경·이미 해본 것을 한국어로 적어주세요. 메모처럼 적어도 됩니다 —
          영문 SR 본문은 자세히 풀어서 써 드립니다.
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
          <button type="button" onClick={onClose} style={ghost} disabled={busy}>
            취소
          </button>
          <button
            type="button"
            onClick={() => void compose()}
            disabled={busy || text.trim() === ""}
            style={primary}
          >
            {busy ? "정리하는 중…" : "정리하기"}
          </button>
        </div>

        {/*
          올리기 전 마지막 확인은 작성 폼이 한다. 여기서는 **정리 자체가 실패한 것만**
          말한다 — 조용히 닫히면 사람은 폼이 왜 안 채워졌는지 알 수 없다.
        */}
        {error !== "" && (
          <div style={{ marginTop: 12 }}>
            <Notice tone="error">{error}</Notice>
          </div>
        )}
      </div>
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
