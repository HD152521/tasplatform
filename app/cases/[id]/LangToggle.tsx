"use client";

/**
 * 대화를 원문(영어)으로 볼지 한국어로 볼지, 그리고 한 번에 전체를 번역하기.
 *
 * 기본은 **원문**이다. 원문이 정본이고, 번역은 읽기를 돕는 보조다.
 *
 * 전체 번역을 남긴 이유: 대화가 수십 건인 케이스는 하나씩 누르는 것이 더 번거롭다.
 * 다만 **자동으로 돌리지 않는다** — 한국어를 고른 순간 전부 번역하면 두세 개만 보려던
 * 사람도 전부 기다려야 하고, 그게 글마다 버튼을 붙인 이유였다. 눌러야 돈다.
 *
 * 번역 여부 판정은 글마다의 버튼과 같은 곳(lib/caseTranslate.ts)을 쓴다. 서버가 세어 준
 * pending 이 두 쪽의 공통 기준이라, 전체 번역을 돌린 뒤 개별 버튼도 함께 "원문 보기" 가 된다.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { COLOR, RADIUS } from "../../ui.tsx";
import { translateButtonStyle } from "../../TranslateButton.tsx";

/**
 * 전체 번역을 이어 부르는 횟수 상한.
 *
 * 라우트가 한 회차에 8건씩만 번역하고 남은 수(left)를 알려 준다. 사용자가 그만큼
 * 다시 누르게 하지 않고 여기서 이어 부르되, 응답이 이상할 때 무한히 돌지 않게 막는다.
 */
const MAX_ROUNDS = 20;

interface TranslateResult {
  ok?: boolean;
  message?: string;
  done?: number;
  left?: number;
}

export function LangToggle({
  requestId,
  lang,
  pending,
}: {
  requestId: number;
  /** 지금 보고 있는 언어. */
  lang: "en" | "ko";
  /** 아직 번역이 없는 건수(한국어 원문과 빈 글은 세지 않는다). */
  pending: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function translateAll(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const response = await fetch(`/api/cases/${requestId}/translate`, { method: "POST" });
        const data = (await response.json()) as TranslateResult;
        if (data.ok !== true) {
          setError(data.message ?? `번역에 실패했습니다 (HTTP ${response.status}).`);
          return;
        }
        // 남은 것이 없거나 한 건도 못 했으면 멈춘다(같은 요청을 되풀이하지 않는다).
        if ((data.left ?? 0) <= 0 || (data.done ?? 0) <= 0) return;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "번역 중 오류가 발생했습니다.");
    } finally {
      setBusy(false);
      // 서버 컴포넌트를 다시 그려 저장된 번역을 싣는다.
      router.refresh();
    }
  }

  const go = (next: "en" | "ko"): void => {
    if (next === lang) return;
    router.push(next === "ko" ? `/cases/${requestId}?lang=ko` : `/cases/${requestId}`);
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <span style={{
        display: "inline-flex", padding: 2, gap: 2,
        background: COLOR.ground, borderRadius: RADIUS.pill,
      }}>
        <Side label="원문" on={lang === "en"} onClick={() => go("en")} />
        <Side label="한국어" on={lang === "ko"} onClick={() => go("ko")} />
      </span>

      {/*
        전체 번역은 한국어 보기에서만 낸다. 원문 보기에서 눌러도 화면은 그대로여서
        "눌렀는데 아무 일도 없다" 로 보인다. 원문 보기에서는 글마다의 버튼을 쓴다.
      */}
      {lang === "ko" && pending > 0 && (
        <button
          type="button" onClick={() => void translateAll()} disabled={busy}
          style={translateButtonStyle(true, busy)}
        >
          {busy ? "번역 중…" : `전체 번역 (${pending}건)`}
        </button>
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
