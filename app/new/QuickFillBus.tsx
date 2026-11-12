"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { QuickFill } from "../../lib/quickFill.ts";

/**
 * 간단히 올리기(머리글의 버튼)가 만든 값을 **작성 폼으로 건넨다.**
 *
 * ## 왜 이런 통로가 필요한가
 *
 * 버튼과 모달은 머리글에 있고(app/new/QuickButton.tsx) 작성 폼은 그 아래에 있다
 * (app/new/DraftForm.tsx). 둘은 형제라 한쪽이 다른 쪽의 상태를 직접 들 수 없다.
 * 페이지는 서버 컴포넌트여서 상태를 들 수 없고(app/new/page.tsx), 그래서 둘을 감싸는
 * 클라이언트 공급자를 하나 둔다.
 *
 * 값은 **한 번만** 건네진다 — 폼이 받아 채운 뒤 `clear()` 로 비운다. 비우지 않으면
 * 폼이 다시 그려질 때마다 사람이 고쳐 둔 값을 같은 값으로 덮는다.
 */
interface Bus {
  readonly fill: QuickFill | null;
  readonly publish: (fill: QuickFill) => void;
  readonly clear: () => void;
}

/**
 * 공급자가 없을 때 쓰는 빈 통로.
 *
 * 던지지 않는다 — 렌더 중에 던지면 SR 작성 화면 전체가 하얗게 된다. 대신 콘솔에
 * 남긴다. 간단히 올리기만 동작하지 않고 직접 작성은 그대로 된다.
 */
const FALLBACK: Bus = {
  fill: null,
  publish: () => {
    console.error("[QuickFillBus] 공급자가 없습니다. app/new/page.tsx 를 확인하세요.");
  },
  clear: () => {},
};

const Ctx = createContext<Bus>(FALLBACK);

export function QuickFillProvider({ children }: { children: React.ReactNode }) {
  const [fill, setFill] = useState<QuickFill | null>(null);
  const publish = useCallback((next: QuickFill) => setFill(next), []);
  const clear = useCallback(() => setFill(null), []);
  const value = useMemo<Bus>(() => ({ fill, publish, clear }), [fill, publish, clear]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useQuickFill(): Bus {
  return useContext(Ctx);
}
