"use client";

import { useEffect, useState } from "react";
import { COLOR, formatStamp } from "./ui.tsx";
import type { SessionState } from "../lib/sessionProbe.ts";

/**
 * 세션 표시등.
 *
 * ## 왜 클라이언트에서 한 번 더 묻나
 *
 * 서버가 넘겨주는 `signedIn` 은 쿠키 **만료 시각**만 본다. 계정 하나를 웹과 수집기가
 * 같이 쓰므로 수집기가 재로그인하면 앞선 세션은 만료 시각 전에도 죽는데, 쿠키는
 * 여전히 미래 시각이라 화면은 "연결됨" 이라고 말한다. 그 거짓말은 **5분 쓴 답변을
 * 전송하는 순간에야** 드러났다.
 *
 * 그래서 화면이 다 그려진 뒤 포털에 한 번 물어본다. 페이지 렌더를 막지 않으므로
 * 체감 속도는 그대로다(포털 왕복 0.15~0.6초).
 *
 * ## 다시 묻는 때
 *
 * 긴 글을 쓰는 동안 세션이 죽는 것이 바로 이 문제의 핵심이다. 탭을 떠났다 돌아오는
 * 순간이 사람이 다시 쓰기 시작하는 순간이라, 그때 한 번 더 묻는다. 주기적으로 돌리지
 * 않는다 — 공용 계정이라 확인 호출 자체가 포털에 남고, 쓰는 사람이 여럿이다.
 */
export function SessionDot({
  signedIn, expiresAt,
}: {
  signedIn: boolean;
  /** 쿠키 만료 시각. 살아 있을 때만 쓴다 — 죽은 세션의 만료 시각은 알려 줄 값이 아니다. */
  expiresAt: number | null;
}) {
  /** 서버가 본 것으로 시작한다(쿠키 기준). 물어본 뒤 진실로 바꾼다. */
  const [state, setState] = useState<SessionState>(signedIn ? "alive" : "dead");
  /** 포털에 물어서 받은 답인가. 아니면 아직 쿠키 기준이다. */
  const [probed, setProbed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function check(): Promise<void> {
      try {
        const response = await fetch("/api/session", { cache: "no-store" });
        const data = (await response.json()) as { ok?: boolean; state?: SessionState };
        if (cancelled || data.ok !== true || data.state === undefined) return;
        // 모름(망 오류·포털 장애)은 **그리지 않는다.** 잠깐 끊긴 VPN 때문에
        // "세션 없음" 이 뜨면 사람이 엉뚱하게 재로그인을 하러 간다.
        if (data.state === "unknown") return;
        setState(data.state);
        setProbed(true);
      } catch {
        // 확인 실패가 화면을 흔들지 않는다. 쿠키 기준 표시를 그대로 둔다.
      }
    }

    void check();

    // 탭으로 돌아오는 순간 = 다시 쓰기 시작하는 순간.
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const alive = state === "alive";
  return (
    <>
    <div style={{
      display: "flex", alignItems: "center", gap: 8, fontSize: 12,
      color: alive ? COLOR.ok : COLOR.waitUs,
    }}>
      <span style={{
        width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
        background: alive ? COLOR.ok : COLOR.waitUs,
      }} />
      <span>{alive ? "세션 연결됨" : "세션 없음"}</span>
      {/*
        확인한 값인지 보이게 한다. 쿠키 기준 표시는 틀릴 수 있다는 것이 이 자리의
        시작점이므로, "확인함" 이 붙었을 때만 믿을 수 있다고 말해 주는 게 정직하다.
      */}
      {probed && (
        <span style={{ fontSize: 10.5, color: COLOR.faint }}>확인함</span>
      )}
    </div>
    <div style={{ fontSize: 11, color: COLOR.faint, marginTop: 5, paddingLeft: 15, lineHeight: 1.6 }}>
      {alive && expiresAt !== null ? `${formatStamp(expiresAt)}까지` : "로그인이 필요합니다"}
    </div>
    </>
  );
}
