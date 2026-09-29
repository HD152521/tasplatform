"use client";

import { useState } from "react";
import { COLOR, RADIUS } from "../../ui.tsx";

/**
 * 답변 본문에 박혀 온 화면 캡처.
 *
 * Broadcom 은 캡처를 **첨부가 아니라 본문 안에** 넣어 보낸다. 우리는 본문을 텍스트로
 * 바꿔 저장하므로 그 이미지를 버리고 있었다 — 파일이 없어서 안 보인 것이 아니라
 * 우리가 지우고 있었다.
 *
 * 원래 주소를 그대로 걸 수 없다. 브라우저에는 포털 세션이 없어 401 이 오고 깨진 그림이
 * 된다. 서버가 대신 받아 내려준다(app/api/inline-image).
 *
 * ## 눌러야 크게 보인다
 *
 * 답변 하나에 캡처가 여러 장 오는 일이 흔하다. 다 펼치면 글이 밀려 읽기 어렵다.
 * 작게 늘어놓고, 누르면 그 자리에서 원래 크기로 편다.
 *
 * ## 실패를 조용히 숨기지 않는다
 *
 * 세션이 끊기면 이미지가 안 온다. 깨진 그림 아이콘만 남으면 사람은 파일이 없어진 줄
 * 안다. 실제로는 다시 로그인하면 되는 상황이라, 그렇게 말해 준다.
 */
export function InlineImages({ ids }: { ids: readonly string[] }) {
  if (ids.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
      {ids.map((id) => <One key={id} id={id} />)}
    </div>
  );
}

function One({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div style={{
        fontSize: 11.5, color: COLOR.muted, lineHeight: 1.5,
        border: `1px dashed ${COLOR.field}`, borderRadius: RADIUS.control,
        padding: "8px 11px",
      }}>
        본문에 있던 이미지를 불러오지 못했습니다. 세션이 끊겼다면 다시 로그인해 주세요.
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      title={open ? "눌러서 작게" : "눌러서 크게"}
      style={{
        padding: 0, border: `1px solid ${COLOR.line}`, borderRadius: RADIUS.control,
        background: COLOR.surface, cursor: "pointer", lineHeight: 0, overflow: "hidden",
        maxWidth: "100%",
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/api/inline-image?id=${encodeURIComponent(id)}`}
        alt="답변에 포함된 이미지"
        loading="lazy"
        onError={() => setFailed(true)}
        style={{
          display: "block",
          maxWidth: open ? "100%" : 180,
          maxHeight: open ? "none" : 130,
          objectFit: "contain",
        }}
      />
    </button>
  );
}
