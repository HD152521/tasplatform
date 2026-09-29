"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_COLLECT_KIND, type CollectKind } from "../lib/collectKind.ts";
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
 *
 * 종류(kind)마다 기다리는 시간과 할 말이 다르다. 케이스 수집만 runs 에 회차를 남겨
 * "새 답변 N건" 을 말할 수 있고, 보안 공지·기술 문서 수집기는 아무 숫자도 남기지 않는다.
 * 그래서 그 둘에는 숫자를 만들어 붙이지 않는다 — 없는 것을 아는 척하는 쪽이 더 나쁘다.
 */

const POLL_MS = 3_000;
/** 이 시간 안에 수집기가 집어가지 않으면 수집기가 안 도는 것으로 본다. */
const PICKUP_LIMIT_MS = 90_000;
/**
 * 한 회차 상한(수집기 쪽 상한과 짝을 맞춘다 — collector/worker.ts). 넘으면 붙잡지 않고
 * 놓아준다. 기술 문서는 본문을 건당 0.9초 간격으로 받아 몇 분이 걸리므로 길게 둔다.
 */
const RUN_LIMIT_MS: Record<CollectKind, number> = {
  cases: 360_000,
  cves: 360_000,
  kb: 660_000,
};
/** 끝난 결과 문구를 얼마나 두고 볼 것인가. 읽을 시간은 되되 화면에 눌어붙지는 않게. */
const DONE_LINGER_MS = 12_000;

/** 수집 중에 보여줄 말. 얼마나 기다려야 하는지 함께 말한다. */
const RUNNING_NOTE: Record<CollectKind, string> = {
  cases: "수집 중입니다… (보통 10초 안에 끝납니다)",
  cves: "보안 공지를 받는 중입니다… (NVD 한도 때문에 1분쯤 걸립니다)",
  kb: "기술 문서를 받는 중입니다… (몇 분 걸릴 수 있습니다)",
};

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
  /** 케이스가 아닌 종류의 성공 여부(수집기 자식 프로세스 종료 결과). */
  succeeded?: boolean;
  message?: string;
}

interface Summary {
  tone: "ok" | "warn" | "error";
  text: string;
}

/** 끝난 회차를 한 문장으로. 숫자만 늘어놓지 않고 무엇을 뜻하는지 말한다. */
function describeRun(run: RunInfo | null): Summary {
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

/**
 * 끝난 요청을 한 문장으로. 종류마다 아는 것이 다르다.
 *
 * 보안 공지·기술 문서는 몇 건을 받았는지 화면이 알 길이 없다(수집기가 표준출력에만
 * 적는다). 그래서 건수를 말하지 않고, 대신 목록을 다시 읽었다는 사실과 어디를 보면
 * 되는지를 말한다. 성공 여부만은 수집기가 남겨 주므로 실패는 실패라고 말한다.
 */
function describeDone(kind: CollectKind, reply: StatusReply): Summary {
  if (kind === "cases") return describeRun(reply.run ?? null);
  if (reply.succeeded === false) {
    return { tone: "error", text: "수집에 실패했습니다. 수집기 로그를 확인하세요." };
  }
  if (kind === "cves") {
    return { tone: "ok", text: "수집 완료 — 목록을 다시 읽었습니다 (받은 건수는 수집기 로그에 있습니다)" };
  }
  return {
    tone: "ok",
    text: "수집 완료 — 목록을 다시 읽었습니다. 판정은 이어서 돕니다(LLM 연결이 있을 때).",
  };
}

export function CollectButton({ kind = DEFAULT_COLLECT_KIND }: { kind?: CollectKind }) {
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

    let ticket: { seq: number; afterRunId: number };
    try {
      const response = await fetch(`/api/collect?kind=${kind}`, { method: "POST" });
      const data = (await response.json()) as {
        ok?: boolean; seq?: number; afterRunId?: number; message?: string;
      };
      if (data.ok !== true || typeof data.seq !== "number") {
        throw new Error(data.message ?? "요청을 남기지 못했습니다.");
      }
      ticket = { seq: data.seq, afterRunId: data.afterRunId ?? 0 };
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
        const response = await fetch(
          `/api/collect?kind=${kind}&seq=${ticket.seq}&after=${ticket.afterRunId}`,
        );
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
          setNote(RUNNING_NOTE[kind]);
        }
        if (waited > RUN_LIMIT_MS[kind]) {
          setPhase("error");
          setTone("warn");
          setNote("수집이 예상보다 오래 걸립니다. 잠시 후 새로고침해 보세요.");
          return;
        }
        continue;
      }

      if (data.state === "done") {
        const summary = describeDone(kind, data);
        setPhase("done");
        setTone(summary.tone);
        setNote(summary.text);
        // 목록을 다시 읽어 새 항목이 그 자리에서 보이게 한다.
        router.refresh();

        // 결과 문구를 잠시 뒤 치운다.
        //
        // 안 치우면 "수집 완료 — 새 답변 없음" 이 화면에 계속 남는다. 시간이 지나면
        // 그게 **언제 것인지** 알 수 없고, 다음에 눌렀을 때도 같은 문장이면 눌린 건지
        // 아닌지 구분이 안 된다. 실패는 사람이 조치해야 하므로 그대로 둔다.
        if (summary.tone === "ok") {
          setTimeout(() => {
            if (!alive.current) return;
            setNote("");
            setPhase("idle");
          }, DONE_LINGER_MS);
        }
        return;
      }

      // 알 수 없는 응답 — 붙잡고 있을 이유가 없다.
      setPhase("error");
      setTone("error");
      setNote(data.message ?? "상태를 알 수 없습니다.");
      return;
    }
  }, [kind, router]);

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
