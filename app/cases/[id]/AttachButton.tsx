"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { COLOR, RADIUS, controlStyle } from "../../ui.tsx";
import { MAX_UPLOAD_LABEL, checkUploadRequest } from "../../../lib/attachmentUpload.ts";

/**
 * 파일 붙이기.
 *
 * ## 답변 전송과 별개다
 *
 * 고르는 즉시 올라간다. 답변 본문과 함께 가지 **않는다** — 첨부는 포털이 아니라
 * supportftp 로 가고, 그건 브라우저가 있는 수집기가 따로 처리하는 일이다
 * (app/api/attachments/upload). 두 개가 한 번에 가는 줄 알면 사람은 파일만 고르고
 * 전송을 누르지 않거나, 반대로 전송했으니 파일도 갔다고 믿는다. 그래서 버튼 이름과
 * title, 그리고 끝난 뒤 문구에서 매번 "따로" 라고 말한다.
 *
 * ## 왜 진행 초를 세는가
 *
 * 수집기가 집어가는 데 최대 15초, 브라우저로 케이스에 들어가는 데 10초가 더 든다.
 * 그 사이에 화면이 조용하면 사람은 고장 난 줄 알고 다시 누른다 — 그러면 케이스에 같은
 * 파일이 두 번 붙는다. 그래서 버튼을 잠그고, 얼마나 지났는지 숫자로 보여준다.
 *
 * ## 실패하면 같은 파일을 다시 고를 수 있어야 한다
 *
 * `<input type="file">` 은 같은 파일을 다시 고르면 change 가 오지 않는다. 값이 그대로라
 * 브라우저가 변경으로 보지 않기 때문이다. 세션이 끊겨 한 번 실패한 뒤 사람이 로그인하고
 * 같은 파일을 다시 고르는 것이 가장 흔한 흐름인데, 그때 아무 일도 일어나지 않으면
 * 고쳐지지 않는 고장으로 보인다. 그래서 끝날 때마다 value 를 비운다.
 */
export function AttachButton({ requestId }: { requestId: number }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  // 올리는 동안만 초를 센다. busy 가 풀리면 정리된다(간격이 남아 돌지 않게).
  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const timer = setInterval(() => setElapsed((n) => n + 1), 1_000);
    return () => clearInterval(timer);
  }, [busy]);

  async function upload(file: File): Promise<void> {
    setNote("");
    setError("");

    // 서버가 판정하는 것과 같은 규칙으로 먼저 걸러 준다. 상한을 넘는 파일을 다 올려보낸
    // 뒤에 거절당하면 회선만 쓰고 사람은 그동안 기다린다.
    const check = checkUploadRequest({ requestId, fileName: file.name, size: file.size });
    if (!check.ok) {
      setError(check.message);
      return;
    }

    setBusy(true);
    try {
      const body = new FormData();
      body.append("requestId", String(requestId));
      body.append("file", file);
      const response = await fetch("/api/attachments/upload", { method: "POST", body });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (data.ok === true) {
        setNote(data.message ?? `${file.name} 을 올렸습니다.`);
        // 첨부 목록은 다음 수집에 반영되므로 지금 보이지 않을 수 있다. 그래도 새로
        // 읽어 둔다 — 이미 반영된 경우에 사람이 바로 확인할 수 있다.
        router.refresh();
        return;
      }
      setError(data.message ?? `올리지 못했습니다 (HTTP ${response.status}).`);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  }

  const title = `답변 전송과 별개로, 고르는 즉시 이 케이스에 파일이 올라갑니다 (${MAX_UPLOAD_LABEL} 이하)`;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        // 올리는 동안은 이 칸도 같이 잠근다. 버튼만 잠그면 키보드로 여기에 포커스를 옮겨
        // 파일을 다시 고를 수 있고, 그러면 같은 파일이 두 번 올라간다 — 큐는 업로드를
        // 합쳐 주지 않는다(lib/attachmentJobs.ts 의 합치기는 다운로드에만 있다).
        disabled={busy}
        // 보이지 않게 두고 버튼이 대신 누른다. display:none 을 쓰지 않는 이유는
        // 일부 브라우저가 숨겨진 입력의 click() 을 무시하기 때문이다.
        style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
        onChange={(event) => {
          const picked = event.target.files?.[0];
          // 같은 파일을 다시 고를 수 있게 즉시 비운다(머리말 참고).
          event.target.value = "";
          if (picked) void upload(picked);
        }}
      />
      <button
        type="button"
        title={title}
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        style={{
          ...controlStyle,
          display: "inline-flex", alignItems: "baseline", gap: 6,
          padding: "7px 12px", fontSize: 12.5, fontWeight: 600,
          color: busy ? COLOR.faint : COLOR.ink,
          background: busy ? COLOR.ground : COLOR.surface,
          cursor: busy ? "default" : "pointer", whiteSpace: "nowrap",
        }}
      >
        {busy ? `올리는 중… ${elapsed}초` : "파일 붙이기"}
        <span style={{ fontSize: 10.5, fontWeight: 400, color: COLOR.faint }}>
          {busy ? "그대로 기다리세요" : "답변과 별개"}
        </span>
      </button>

      {/*
        상태 문구는 버튼 줄의 **다음 줄 전체**를 쓴다(flexBasis 100%). 부모는 wrap 되는
        flex 줄이라, 문장을 버튼들 사이에 끼우면 긴 실패 메시지가 전송 버튼을 밀어내고
        좁은 화면에서 줄이 엉킨다. 한 줄을 통째로 차지하면 1440·760 둘 다 안 흔들린다.

        order:1 이 필요한 이유 — 이 문구는 DOM 상 파일 붙이기 버튼 바로 뒤에 있어서,
        그대로 두면 문구가 번역·정리·전송 **사이를 갈라** 전송 버튼을 아래로 밀어낸다.
        사람이 전송을 누르려는 순간 버튼이 내려가면 안 된다. 그래서 그리는 순서만 뒤로 민다.
      */}
      {(busy || note !== "" || error !== "") && (
        <div
          role="status"
          style={{
            flexBasis: "100%", minWidth: 0, order: 1,
            fontSize: 11.5, lineHeight: 1.6, wordBreak: "break-word",
            color: error !== "" ? COLOR.waitUs : busy ? COLOR.muted : COLOR.ok,
            background: error !== "" ? COLOR.waitUsBg : "transparent",
            border: error !== "" ? "1px solid #f3c7c2" : "1px solid transparent",
            borderRadius: RADIUS.control,
            padding: error !== "" ? "8px 11px" : "2px 2px 0",
          }}
        >
          {error !== ""
            ? error
            : busy
              // 수집기가 집어가는 데 최대 15초, 브라우저 진입에 10초가 더 든다.
              ? "수집기가 브라우저로 올립니다. 1분 가까이 걸릴 수 있습니다 — 다시 누르지 마세요."
              : note}
        </div>
      )}
    </>
  );
}
