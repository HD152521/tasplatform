"use client";

import { useState } from "react";
import { COLOR, RADIUS } from "../ui.tsx";
import { QuickModal } from "./QuickModal.tsx";

/**
 * "간단히 올리기" 버튼과 그 모달.
 *
 * 모달만 클라이언트로 두려고 버튼을 따로 뺐다. 페이지(app/new/page.tsx)는 서버
 * 컴포넌트로 남아 Product · Component 목록을 DB 에서 읽는다 — 그 목록은 **작성 폼**이
 * 쓰고, 간단히 올리기는 라우트가 서버에서 다시 읽는다(목록을 클라이언트로 내릴 필요가 없다).
 */
export function QuickButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer",
          color: COLOR.accent, background: "transparent",
          border: `1px solid ${COLOR.accent}`, borderRadius: RADIUS.control,
        }}
      >
        간단히 올리기
      </button>
      {open && <QuickModal onClose={() => setOpen(false)} />}
    </>
  );
}
