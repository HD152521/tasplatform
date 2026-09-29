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

/**
 * 어디서 받았는지 알려주는 응답 헤더(app/api/attachments/[id]).
 *
 * `ours` 는 우리가 올릴 때 남겨 둔 사본이라는 뜻이다. 굳이 알려주는 이유: 그 파일은
 * supportftp 에 더 이상 없어서 포털에서 눌러도 못 받는다. 이 화면에서만 받을 수 있다는
 * 사실을 모르면 사람은 다른 데서 다시 찾아 헤맨다.
 */
const SOURCE_HEADER = "X-Attachment-Source";

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
  const [fromOurs, setFromOurs] = useState(false);

  async function download(): Promise<void> {
    setBusy(true);
    setError("");
    setFromOurs(false);
    try {
      const response = await fetch(`/api/attachments/${documentId}`);
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { message?: string };
        setError(data.message ?? `받지 못했습니다 (HTTP ${response.status}).`);
        return;
      }
      // 같은 원본이라 헤더를 읽어야 구분된다. 저장보다 먼저 읽는다 — blob() 뒤에는
      // 응답을 다시 볼 이유가 없고, 순서를 헷갈리지 않게 여기서 끝낸다.
      const ours = response.headers.get(SOURCE_HEADER) === "ours";
      saveBlob(await response.blob(), fileName);
      setFromOurs(ours);
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
      {fromOurs && !busy && (
        <div style={{ fontSize: 11.5, color: COLOR.muted, padding: "2px 0 0 2px" }}>
          {/* 이 파일은 supportftp 에 없다. 우리가 올릴 때 남겨 둔 사본으로 받은 것이다. */}
          우리가 보관한 사본에서 받았습니다
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
