"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { COLOR, formatStamp } from "./ui.tsx";
import type { CollectorHealth } from "../lib/collectorHealth.ts";
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
 *
 * ## 죽었을 때 할 일을 여기서 내준다
 *
 * 전에는 "로그인이 필요합니다" 였다. **웹에서는 로그인할 수 없다** — 컨테이너에
 * 브라우저가 없다(SR_DISABLE_BROWSER_LOGIN). 막다른 안내였고, 사람이 할 수 있는 일은
 * 수집기 기계에 들어가 `npm run refresh` 를 돌리는 것뿐이었다.
 *
 * 실제로 세션을 되살리는 것은 수집기다 — 회차를 시작할 때 죽은 세션을 저장된 계정으로
 * 스스로 되살린다(collector/collect.ts). 그래서 여기서 "한 회차를 지금 돌려 달라" 고
 * 요청한다(lib/collectRequest.ts — "지금 수집" 이 쓰는 그 통로다. 새 구조가 필요 없다).
 *
 * 단 수집기가 멈춰 있으면 요청은 줄에 남아 아무 일도 일어나지 않는다. 그때 버튼을
 * 보여 주면 사람은 누르고 영원히 기다린다. 그래서 수집기 상태를 함께 받아
 * (`/api/session`) 버튼과 안내를 가른다.
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
  const [collector, setCollector] = useState<CollectorHealth | null>(null);
  /** 재로그인을 요청한 뒤 기다리는 중인가. */
  const [asking, setAsking] = useState(false);
  const [asked, setAsked] = useState("");
  /** 떠난 뒤에도 돌고 있는 폴링을 멈추기 위한 표시. */
  const alive0 = useRef(true);

  const check = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch("/api/session", { cache: "no-store" });
      const data = (await response.json()) as {
        ok?: boolean;
        state?: SessionState;
        collector?: CollectorHealth | null;
      };
      if (!alive0.current || data.ok !== true) return;
      if (data.collector !== undefined && data.collector !== null) setCollector(data.collector);
      if (data.state === undefined) return;
      // 모름(망 오류·포털 장애)은 **그리지 않는다.** 잠깐 끊긴 VPN 때문에
      // "세션 없음" 이 뜨면 사람이 엉뚱하게 재로그인을 하러 간다.
      if (data.state === "unknown") return;
      setState(data.state);
      setProbed(true);
    } catch {
      // 확인 실패가 화면을 흔들지 않는다. 쿠키 기준 표시를 그대로 둔다.
    }
  }, []);

  useEffect(() => {
    alive0.current = true;
    void check();

    // 탭으로 돌아오는 순간 = 다시 쓰기 시작하는 순간.
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive0.current = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [check]);

  /**
   * 수집기에 한 회차를 요청한다 — 그 회차가 죽은 세션을 되살린다.
   *
   * 끝날 때까지 되묻고, 끝나면 세션을 **다시 확인한다.** 끝났다고만 말하면 사람은
   * 세션이 살아났는지 알 수 없어 또 쓰기를 시도하고, 또 막힐 수 있다.
   */
  async function askCollector(): Promise<void> {
    setAsking(true);
    setAsked("수집기에 요청했습니다…");
    try {
      const res = await fetch("/api/collect", { method: "POST" });
      const data = (await res.json()) as { ok?: boolean; seq?: number; afterRunId?: number; message?: string };
      if (data.ok !== true || typeof data.seq !== "number") {
        setAsked(data.message ?? "요청하지 못했습니다.");
        return;
      }
      const seq = data.seq;
      const after = data.afterRunId ?? 0;

      // 수집은 몇 분 걸린다. 5초마다 묻고, 상한을 넘겨도 실패라고 말하지 않는다 —
      // 요청은 줄에 남아 있고 수집기가 결국 돌린다.
      const deadline = Date.now() + 10 * 60_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 5_000));
        if (!alive0.current) return;
        try {
          const poll = await fetch(`/api/collect?seq=${seq}&after=${after}`, { cache: "no-store" });
          const got = (await poll.json()) as { ok?: boolean; state?: string };
          if (got.ok === true && got.state === "done") {
            await check();
            setAsked("수집기가 한 회차를 돌렸습니다. 세션을 다시 확인했습니다.");
            return;
          }
          if (got.ok === true && got.state === "running") setAsked("수집기가 도는 중입니다…");
        } catch {
          // 한 번 못 물어도 계속 기다린다. 요청은 줄에 남아 있다.
        }
        if (Date.now() > deadline) {
          setAsked("수집기가 아직 돌지 않았습니다. 요청은 줄에 남아 있습니다 — 잠시 후 새로고침해 보세요.");
          return;
        }
      }
    } catch (error) {
      setAsked(error instanceof Error ? error.message : String(error));
    } finally {
      setAsking(false);
    }
  }

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
      {alive && expiresAt !== null ? `${formatStamp(expiresAt)}까지` : collectorHint(collector)}
    </div>

    {/*
      죽었을 때만 할 일을 내준다. 살아 있을 때 버튼을 두면 "지금 수집" 과 구분이 안 되고,
      공용 계정에 쓸데없는 재로그인을 만든다.
    */}
    {!alive && collector !== null && collector.canAsk && (
      <div style={{ marginTop: 7, paddingLeft: 15 }}>
        <button
          type="button"
          onClick={() => void askCollector()}
          disabled={asking}
          style={{
            fontSize: 11, fontFamily: "inherit", cursor: asking ? "default" : "pointer",
            color: COLOR.ink, background: COLOR.surface,
            border: `1px solid ${COLOR.field}`, borderRadius: 999,
            padding: "4px 9px", opacity: asking ? 0.6 : 1,
          }}
        >
          {asking ? "요청함 · 기다리는 중…" : "수집기에 재로그인 요청"}
        </button>
      </div>
    )}
    {asked !== "" && (
      <div style={{
        fontSize: 10.5, color: COLOR.muted, marginTop: 5, paddingLeft: 15, lineHeight: 1.6,
      }}>
        {asked}
      </div>
    )}
    </>
  );
}

/**
 * 세션이 죽었을 때 뭐라고 말할까.
 *
 * "로그인이 필요합니다" 는 **막다른 안내**였다 — 웹에서는 로그인할 수 없다. 수집기가
 * 돌고 있으면 요청하면 되고, 멈춰 있으면 기계를 봐야 한다. 그 둘을 가려 말한다.
 */
function collectorHint(collector: CollectorHealth | null): string {
  if (collector === null) return "세션이 없습니다.";
  if (collector.state === "never") {
    return "수집기가 한 번도 돌지 않았습니다. 수집기를 먼저 띄워 주세요.";
  }
  if (collector.state === "stalled") {
    const quiet = minutesOf(collector.quietMs);
    const maybe = collector.knowsHours ? "" : " (운영 시간대 밖이면 정상입니다)";
    return `수집기가 ${quiet} 동안 돌지 않았습니다${maybe}. 수집기 VM 을 확인하세요.`;
  }
  if (collector.state === "resting") {
    return "운영 시간대 밖입니다. 요청하면 수집기가 깨어나 세션을 되살립니다.";
  }
  return "수집기에 요청하면 세션을 되살립니다.";
}

/** 사람이 읽을 길이. 분이 넘치면 시간으로 바꾼다. */
function minutesOf(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}시간` : `${Math.round(hours / 24)}일`;
}
