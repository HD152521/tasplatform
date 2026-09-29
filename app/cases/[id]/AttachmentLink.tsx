"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { COLOR } from "../../ui.tsx";

/**
 * 첨부 한 줄. 눌러서 받는다.
 *
 * `<a download>` 을 쓰지 않는다. 그 방식은 서버가 무엇을 돌려주든 파일로 저장해 버려서,
 * 실패했을 때 오류 본문이 첨부 이름으로 저장된다 — 화면에서는 "사용할 수 없는 파일" 로
 * 보이고 진짜 이유는 어디에도 안 남는다. 그 증상을 고치려다 오히려 Broadcom 으로
 * 튕겨 보내기도 했다. 받아온 다음에 저장할지 말지를 여기서 정한다.
 *
 * 실패 이유는 사람이 할 일이 다르다 — 서버에서 지워진 파일인지, 세션이 죽은 것인지,
 * 그냥 오래 걸리는 것인지. 그래서 그 자리에 문장으로 보여준다.
 */

/** 받아온 내용을 파일로 저장시킨다. */
function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name || "download";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 바로 지우면 저장이 시작되기 전에 사라지는 브라우저가 있다.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function AttachmentLink({
  documentId,
  fileName,
  style,
  children,
}: {
  documentId: number;
  fileName: string;
  style: CSSProperties;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function download(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/attachments/${documentId}`);
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { message?: string };
        setError(data.message ?? `받지 못했습니다 (HTTP ${response.status}).`);
        return;
      }
      saveBlob(await response.blob(), fileName);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void download()}
        disabled={busy}
        style={{
          ...style,
          width: "100%",
          textAlign: "left",
          font: "inherit",
          cursor: busy ? "default" : "pointer",
          opacity: busy ? 0.6 : 1,
        }}
      >
        {children}
      </button>
      {busy && (
        <div style={{ fontSize: 11.5, color: COLOR.muted, padding: "2px 0 0 2px" }}>
          {/* 수집기가 브라우저로 받아 온다. 처음 한 번은 수십 초가 걸린다. */}
          받아오는 중… 처음 한 번은 수십 초 걸립니다
        </div>
      )}
      {error !== "" && (
        <div role="status" style={{ fontSize: 11.5, color: COLOR.waitUs, padding: "2px 0 0 2px", lineHeight: 1.5 }}>
          {error}
        </div>
      )}
    </>
  );
}
