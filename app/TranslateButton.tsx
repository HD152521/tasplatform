"use client";

/**
 * 한 항목을 한국어로 번역시키는 버튼.
 *
 * 보안 공지(NVD)와 기술 문서(Broadcom KB)는 전부 영문으로 들어온다. 목록을 통째로
 * 번역해 두면 안 볼 글까지 AI 를 부르게 되므로, **볼 것만 눌러서** 번역한다.
 *
 * 한 번 번역하면 DB 에 남아 다음부터는 바로 보인다. 그래서 버튼은 번역이 없을 때만
 * 나온다. 눌러서 끝나면 서버 컴포넌트를 다시 그려 저장된 번역을 싣는다.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CSSProperties } from "react";
import { COLOR, RADIUS } from "./ui.tsx";

/**
 * 이 버튼의 모양.
 *
 * 번역과 "원문 보기" 전환은 같은 자리에서 번갈아 나오므로 모양이 한 픽셀이라도
 * 다르면 누를 때 자리가 튄다. 그래서 전환 버튼도 이 함수를 쓴다.
 */
export function translateButtonStyle(compact: boolean, dim = false): CSSProperties {
  return {
    padding: compact ? "3px 9px" : "5px 11px",
    fontSize: compact ? 11 : 12, fontFamily: "inherit",
    color: dim ? COLOR.faint : COLOR.body,
    background: COLOR.surface,
    border: `1px solid ${COLOR.field}`, borderRadius: RADIUS.badge,
    cursor: dim ? "default" : "pointer", whiteSpace: "nowrap",
  };
}

export function TranslateButton({
  url, label = "번역", busyLabel = "번역 중…", compact = false, onDone,
}: {
  /** POST 할 주소. */
  url: string;
  label?: string;
  busyLabel?: string;
  /** 목록 안에 들어갈 때의 작은 모양. */
  compact?: boolean;
  /**
   * 번역이 끝난 뒤 부른다.
   *
   * 목록 화면은 새로 그리면 번역이 저절로 보이지만, 케이스 화면은 글마다 원문·번역을
   * 번갈아 보는 자리가 있어 "지금 누른 이 글은 번역을 보여 달라" 를 기억해야 한다.
   */
  onDone?: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(url, { method: "POST" });
      const data = (await response.json()) as { ok?: boolean; message?: string };
      if (data.ok !== true) {
        setError(data.message ?? `번역에 실패했습니다 (HTTP ${response.status}).`);
        return;
      }
      onDone?.();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "번역 중 오류가 발생했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
      <button
        type="button" onClick={() => void run()} disabled={busy}
        style={translateButtonStyle(compact, busy)}
      >
        {busy ? busyLabel : label}
      </button>
      {error !== "" && (
        <span style={{ fontSize: 11, color: COLOR.waitUs, lineHeight: 1.4 }}>{error}</span>
      )}
    </span>
  );
}
