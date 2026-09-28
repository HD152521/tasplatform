"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { COLOR, controlStyle } from "./ui.tsx";

/**
 * "지금 수집" 버튼.
 *
 * 누르면 수집이 이 자리에서 돌지 않는다 — 웹에는 Playwright 가 없고, 수집은 수집기가
 * 도는 기계에서만 된다. 그래서 요청만 남기고(POST) 진행 상태를 물어보며 따라간다(GET).
 * 사람이 버튼을 누르고 기다리는 구간이므로 **지금 무슨 일이 벌어지는지 계속 말해준다** —
 * 눌렀는데 아무 반응이 없으면 다시 누르게 되고, 그게 제일 나쁘다.
 *
 *   요청함 → 수집기가 집어가길 기다림 → 수집 중 → 끝. 새 답변 N건
 *
 * 끝나면 router.refresh() 로 목록을 다시 읽는다. 새 답변이 있으면 그 자리에서 보인다.
 */

const POLL_MS = 3_000;
/** 이 시간 안에 수집기가 집어가지 않으면 수집기가 안 도는 것으로 본다. */
const PICKUP_LIMIT_MS = 90_000;
/** 한 회차 상한(worker 기본값과 같다). 넘으면 붙잡지 않고 놓아준다. */
const RUN_LIMIT_MS = 360_000;

type Phase = "idle" | "queued" | "running" | "done" | "error";

interface RunInfo {
  status: string;
  cases_seen: number;
  cases_changed: number;
  new_threads: number;
  error: string | null;
}

interface StatusReply {
  ok?: boolean;
  state?: "idle" | "queued" | "running" | "done";
  run?: RunInfo | null;
  message?: string;
}

/** 끝난 회차를 한 문장으로. 숫자만 늘어놓지 않고 무엇을 뜻하는지 말한다. */
function describeRun(run: RunInfo | null): { tone: "ok" | "warn" | "error"; text: string } {
  if (run === null) return { tone: "warn", text: "수집 기록을 읽지 못했습니다." };
  if (run.status === "session_expired") {
    // 이걸 "새 답변 0건" 으로 보여주면 안 된다 — 아예 못 읽은 것이다.
    return { tone: "error", text: "세션이 만료되어 수집하지 못했습니다. 다시 로그인하세요." };
  }
  if (run.status !== "success") {
    return { tone: "error", text: run.error ?? "수집에 실패했습니다." };
  }
  if (run.new_threads > 0) {
    return { tone: "ok", text: `수집 완료 — 새 답변 ${run.new_threads}건` };
  }
  if (run.cases_changed > 0) {
    return { tone: "ok", text: `수집 완료 — 변경 ${run.cases_changed}건, 새 답변은 없습니다` };
  }
  return { tone: "ok", text: `수집 완료 — 새 답변 없음 (케이스 ${run.cases_seen}건 확인)` };
}

export function CollectButton() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [note, setNote] = useState("");
  const [tone, setTone] = useState<"ok" | "warn" | "error">("ok");
  // 언마운트 뒤에 폴링이 남아 setState 하지 않도록 잡아 둔다.
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const start = useCallback(async () => {
    setPhase("queued");
    setNote("수집을 요청했습니다. 수집기가 집어가길 기다립니다…");
    setTone("ok");

    let requestedAt: string;
    try {
      const response = await fetch("/api/collect", { method: "POST" });
      const data = (await response.json()) as { ok?: boolean; requestedAt?: string; message?: string };
      if (data.ok !== true || typeof data.requestedAt !== "string") {
        throw new Error(data.message ?? "요청을 남기지 못했습니다.");
      }
      requestedAt = data.requestedAt;
    } catch (error) {
      if (!alive.current) return;
      setPhase("error");
      setTone("error");
      setNote(error instanceof Error ? error.message : String(error));
      return;
    }

    const startedAt = Date.now();
    let sawRunning = false;

    // 폴링. 끝나거나, 기다릴 이유가 없어지면 멈춘다.
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (!alive.current) return;

      let data: StatusReply;
      try {
        const response = await fetch(`/api/collect?since=${encodeURIComponent(requestedAt)}`);
        data = (await response.json()) as StatusReply;
      } catch {
        continue; // 한 번 못 물어본 것으로 포기하지 않는다
      }
      if (!alive.current) return;

      const waited = Date.now() - startedAt;

      if (data.state === "queued") {
        if (waited > PICKUP_LIMIT_MS) {
          setPhase("error");
          setTone("error");
          setNote("수집기가 요청을 집어가지 않습니다. 수집기가 돌고 있는지 확인하세요.");
          return;
        }
        continue;
      }

      if (data.state === "running") {
        if (!sawRunning) {
          sawRunning = true;
          setPhase("running");
          setNote("수집 중입니다… (보통 10초 안에 끝납니다)");
        }
        if (waited > RUN_LIMIT_MS) {
          setPhase("error");
          setTone("warn");
          setNote("수집이 예상보다 오래 걸립니다. 잠시 후 새로고침해 보세요.");
          return;
        }
        continue;
      }

      if (data.state === "done") {
        const summary = describeRun(data.run ?? null);
        setPhase("done");
        setTone(summary.tone);
        setNote(summary.text);
        // 목록을 다시 읽어 새 답변이 그 자리에서 보이게 한다.
        router.refresh();
        return;
      }

      // 알 수 없는 응답 — 붙잡고 있을 이유가 없다.
      setPhase("error");
      setTone("error");
      setNote(data.message ?? "상태를 알 수 없습니다.");
      return;
    }
  }, [router]);

  const busy = phase === "queued" || phase === "running";
  const toneColor = tone === "ok" ? COLOR.ok : tone === "warn" ? COLOR.warn : COLOR.waitUs;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <button
        type="button"
        onClick={() => { void start(); }}
        disabled={busy}
        style={{
          ...controlStyle,
          borderColor: busy ? COLOR.field : COLOR.accent,
          color: busy ? COLOR.faint : COLOR.accent,
          fontWeight: 600,
          cursor: busy ? "default" : "pointer",
        }}
      >
        {busy ? "수집 중…" : "지금 수집"}
      </button>
      {note !== "" && (
        <span
          role="status"
          aria-live="polite"
          style={{ fontSize: 12.5, color: busy ? COLOR.muted : toneColor }}
        >
          {note}
        </span>
      )}
    </div>
  );
}
