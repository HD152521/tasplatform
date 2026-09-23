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
import { COLOR, RADIUS } from "./ui.tsx";

export function TranslateButton({
  url, label = "번역", busyLabel = "번역 중…", compact = false,
}: {
  /** POST 할 주소. */
  url: string;
  label?: string;
  busyLabel?: string;
  /** 목록 안에 들어갈 때의 작은 모양. */
  compact?: boolean;
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
        style={{
          padding: compact ? "3px 9px" : "5px 11px",
          fontSize: compact ? 11 : 12, fontFamily: "inherit",
          color: busy ? COLOR.faint : COLOR.body,
          background: COLOR.surface,
          border: `1px solid ${COLOR.field}`, borderRadius: RADIUS.badge,
          cursor: busy ? "default" : "pointer", whiteSpace: "nowrap",
        }}
      >
        {busy ? busyLabel : label}
      </button>
      {error !== "" && (
        <span style={{ fontSize: 11, color: COLOR.waitUs, lineHeight: 1.4 }}>{error}</span>
      )}
    </span>
  );
}
