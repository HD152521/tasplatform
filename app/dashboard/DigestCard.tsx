"use client";

/**
 * 지난 주 정리 — 대시보드 한 구석.
 *
 * ## 왜 서버에서 안 읽고 여기서 부르나
 *
 * 정리를 **읽는** 길과 **만드는** 길이 같은 API 에 있고(app/api/calendar/digest),
 * GET 에 `today` 를 주면 "지난 주 것이 아직 없으면 한 번 만든다" 가 같이 돈다
 * (lib/weeklyDigest.ts autoBuildLastWeek). 그 생성은 LLM 을 때릴 수 있어 **대시보드
 * 렌더를 붙잡으면 안 된다** — 화면이 뜬 뒤에 채우는 쪽이 맞다.
 *
 * 그래서 카드가 스스로 부른다. 실패해도 대시보드의 다른 칸은 멀쩡하다.
 */

import { useEffect, useState } from "react";
import type { WeeklyDigest } from "../../lib/weeklyDigest.ts";
import { COLOR, Card, Empty, LinkButton, MONO_STACK, SPACE, SectionHead, TEXT, WEIGHT } from "../ui.tsx";

/**
 * 서버가 돌려주는 그 모양을 **그대로** 쓴다.
 *
 * 전에는 여기서 `{ week, content, source, builtAt }` 를 손으로 다시 적었는데, 서버는
 * `{ week, body, source, createdAt }` 를 보낸다. 이름이 어긋나 `digest.content` 가
 * undefined 였고, 정리가 **생긴 순간** `undefined.split()` 이 터져 대시보드가 통째로
 * "Application error" 로 바뀌었다. 정리가 없는 동안은 멀쩡했으니 더 찾기 어려웠다.
 *
 * 타입만 가져온다(`import type`) — 컴파일에서 사라지므로 서버 코드가 브라우저로
 * 따라오지 않고, 서버가 모양을 바꾸면 **빌드가 먼저 깨진다.** 손으로 베낀 모양은
 * 그 경고를 주지 못한다.
 */
type Digest = WeeklyDigest;

/** 길면 접는다. 대시보드는 훑는 화면이고, 전문은 펼쳐서 읽는다. */
const FOLD_LINES = 6;

export function DigestCard({ week, today, label }: { week: string; today: string; label: string }) {
  const [digest, setDigest] = useState<Digest | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [message, setMessage] = useState("");
  const [open, setOpen] = useState(false);
  const [building, setBuilding] = useState(false);

  async function load(): Promise<void> {
    setState("loading");
    try {
      // today 를 함께 넘겨 "없으면 한 번 만든다" 를 깨운다.
      const res = await fetch(
        `/api/calendar/digest?week=${encodeURIComponent(week)}&today=${encodeURIComponent(today)}`,
        { cache: "no-store" },
      );
      const data = (await res.json()) as { ok?: boolean; digest?: Digest | null; message?: string };
      if (data.ok !== true) {
        setState("failed");
        setMessage(data.message ?? "정리를 읽지 못했습니다.");
        return;
      }
      setDigest(data.digest ?? null);
      setState("ready");
    } catch (error) {
      setState("failed");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function build(): Promise<void> {
    setBuilding(true);
    setMessage("");
    try {
      const res = await fetch("/api/calendar/digest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ week }),
      });
      const data = (await res.json()) as { ok?: boolean; digest?: Digest; message?: string };
      if (data.ok !== true) {
        setMessage(data.message ?? "만들지 못했습니다.");
        return;
      }
      setDigest(data.digest ?? null);
      setOpen(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBuilding(false);
    }
  }

  useEffect(() => {
    void load();
    // week 가 바뀌면 다시 읽는다. load 는 매 렌더 새로 만들어지므로 의존성에 넣지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [week, today]);

  const lines = digest === null ? [] : digest.body.split("\n");
  const folded = !open && lines.length > FOLD_LINES;
  const shown = folded ? lines.slice(0, FOLD_LINES) : lines;

  return (
    <Card style={{ padding: SPACE.lg, gridColumn: "1 / -1" }}>
      <SectionHead
        title={`지난 주 정리 · ${label}`}
        right={
          digest === null ? null : (
            <span style={{ display: "inline-flex", gap: SPACE.sm, alignItems: "center" }}>
              <span
                title={
                  digest.source === "llm"
                    ? "AI 가 요약했습니다"
                    : "AI 연결이 없어 규칙으로 뽑았습니다(건수·사람·망 집계)"
                }
                style={{
                  fontSize: TEXT.micro, fontWeight: WEIGHT.semibold,
                  color: digest.source === "llm" ? COLOR.accent : COLOR.muted,
                }}
              >
                {digest.source === "llm" ? "AI 요약" : "규칙 집계"}
              </span>
              <LinkButton onClick={() => void build()} disabled={building}>
                {building ? "만드는 중…" : "다시 만들기"}
              </LinkButton>
            </span>
          )
        }
      />

      {state === "loading" && (
        <p style={{ margin: 0, fontSize: TEXT.small, color: COLOR.faint }}>읽는 중…</p>
      )}

      {state === "failed" && (
        <p style={{ margin: 0, fontSize: TEXT.small, color: COLOR.waitUs }}>{message}</p>
      )}

      {state === "ready" && digest === null && (
        <Empty>
          지난 주 정리가 아직 없습니다.{" "}
          <LinkButton onClick={() => void build()} disabled={building}>
            {building ? "만드는 중…" : "지금 만들기"}
          </LinkButton>
          {message !== "" && (
            <span style={{ display: "block", marginTop: SPACE.xs, color: COLOR.waitUs }}>{message}</span>
          )}
        </Empty>
      )}

      {state === "ready" && digest !== null && (
        <>
          {/* 줄바꿈이 뜻을 가진 글이다 — 문단으로 뭉개지 않고 줄 그대로 둔다. */}
          <div style={{ fontSize: TEXT.base, lineHeight: 1.75, color: COLOR.ink, whiteSpace: "pre-wrap" }}>
            {shown.join("\n")}
            {folded && "…"}
          </div>
          <div style={{ display: "flex", gap: SPACE.md, alignItems: "center", marginTop: SPACE.sm }}>
            {lines.length > FOLD_LINES && (
              <LinkButton onClick={() => setOpen(!open)}>{open ? "접기" : `전문 보기 (${lines.length}줄)`}</LinkButton>
            )}
            <span style={{ fontFamily: MONO_STACK, fontSize: TEXT.micro, color: COLOR.faint }}>
              {digest.createdAt.slice(0, 16).replace("T", " ")}
            </span>
          </div>
          {message !== "" && (
            <p style={{ margin: `${SPACE.xs}px 0 0`, fontSize: TEXT.micro, color: COLOR.waitUs }}>{message}</p>
          )}
        </>
      )}
    </Card>
  );
}
