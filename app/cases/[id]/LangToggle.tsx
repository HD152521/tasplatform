"use client";

/**
 * 대화를 원문(영어)으로 볼지 한국어로 볼지.
 *
 * 기본은 **원문**이다. 원문이 정본이고, 번역은 읽기를 돕는 보조다.
 * 한국어를 고르면 아직 번역이 없는 건만 만들어 저장한다(한 번 만들면 다시 안 부른다).
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { COLOR, RADIUS } from "../../ui.tsx";

export function LangToggle({
  requestId,
  lang,
  pending,
}: {
  requestId: number;
  /** 지금 보고 있는 언어. */
  lang: "en" | "ko";
  /** 한국어로 볼 때 아직 번역이 없는 건수. */
  pending: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 같은 화면에서 두 번 돌지 않게 한다(렌더가 여러 번 일어나도 한 번만).
  const running = useRef(false);

  useEffect(() => {
    if (lang !== "ko" || pending === 0 || running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    void (async () => {
      try {
        const response = await fetch(`/api/cases/${requestId}/translate`, { method: "POST" });
        const data = (await response.json()) as { ok?: boolean; message?: string };
        if (data.ok !== true) setError(data.message ?? "번역에 실패했습니다.");
      } catch (e) {
        setError(e instanceof Error ? e.message : "번역 중 오류가 발생했습니다.");
      } finally {
        setBusy(false);
        running.current = false;
        // 서버 컴포넌트를 다시 그려 저장된 번역을 싣는다.
        router.refresh();
      }
    })();
  }, [lang, pending, requestId, router]);

  const go = (next: "en" | "ko"): void => {
    if (next === lang) return;
    router.push(next === "ko" ? `/cases/${requestId}?lang=ko` : `/cases/${requestId}`);
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span style={{
        display: "inline-flex", padding: 2, gap: 2,
        background: COLOR.ground, borderRadius: RADIUS.pill,
      }}>
        <Side label="원문" on={lang === "en"} onClick={() => go("en")} />
        <Side label="한국어" on={lang === "ko"} onClick={() => go("ko")} />
      </span>
      {busy && (
        <span style={{ fontSize: 11.5, color: COLOR.muted }}>
          {`번역하는 중… (${pending}건)`}
        </span>
      )}
      {!busy && error !== "" && (
        <span style={{ fontSize: 11.5, color: COLOR.waitUs }}>{error}</span>
      )}
      {/* 남은 것이 있으면 왜 원문이 섞여 보이는지 알려 준다. */}
      {!busy && error === "" && lang === "ko" && pending > 0 && (
        <span style={{ fontSize: 11.5, color: COLOR.faint }}>
          {`${pending}건은 원문 그대로입니다`}
        </span>
      )}
    </span>
  );
}

function Side({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button" onClick={onClick} aria-pressed={on}
      style={{
        padding: "4px 12px", fontSize: 12, fontFamily: "inherit",
        fontWeight: on ? 600 : 400,
        color: on ? COLOR.ink : COLOR.muted,
        background: on ? COLOR.surface : "transparent",
        border: on ? `1px solid ${COLOR.field}` : "1px solid transparent",
        borderRadius: RADIUS.pill, cursor: on ? "default" : "pointer",
      }}
    >
      {label}
    </button>
  );
}
