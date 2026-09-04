import { getLastRun, listCasesSplit, type CaseListRow } from "../lib/queries.ts";
import { CaseList } from "./CaseList.tsx";
import { COLOR, Notice, formatStamp } from "./ui.tsx";

export const dynamic = "force-dynamic";

function formatRunTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : formatStamp(d.getTime());
}

export default function CaseListPage() {
  let open: CaseListRow[] = [];
  let lastRun = null;
  let loadError: string | null = null;

  try {
    open = listCasesSplit().open;
    lastRun = getLastRun();
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  const unread = open.filter((c) => c.unread_replies > 0).length;
  const stale = lastRun !== null && lastRun.status !== "success";

  return (
    <>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>
          진행중 케이스
        </h1>
        <p style={{ margin: "7px 0 0", fontSize: 13 }}>
          {/* 숫자를 나열하지 말고, 지금 해야 할 일을 문장으로 먼저 말한다. */}
          <span style={{
            color: unread > 0 ? COLOR.waitUs : COLOR.muted,
            fontWeight: unread > 0 ? 500 : 400,
          }}>
            {unread > 0
              ? `답변이 온 케이스 ${unread}건이 확인을 기다리고 있습니다`
              : "새로 확인할 답변이 없습니다"}
          </span>
          {lastRun !== null && (
            <span style={{ color: COLOR.faint }}>
              {`  ·  마지막 수집 ${formatRunTime(lastRun.started_at)}`}
            </span>
          )}
        </p>
      </header>

      {loadError !== null && <Notice tone="error">DB를 읽지 못했습니다: {loadError}</Notice>}

      {stale && lastRun !== null && (
        <Notice tone={lastRun.status === "session_expired" ? "warn" : "error"}>
          <b>{lastRun.status === "session_expired" ? "세션이 만료되어" : "수집에 실패하여"}</b>
          {" 마지막 수집이 완료되지 않았습니다. 아래 목록은 최신이 아니며, "}
          <b>“새 답변 없음”을 뜻하지 않습니다.</b>
          {lastRun.error !== null && (
            <div style={{ marginTop: 6, fontSize: 12.5, opacity: 0.9 }}>{lastRun.error}</div>
          )}
        </Notice>
      )}

      {loadError === null && open.length === 0 && (
        <Notice tone="warn">
          {"수집된 진행중 케이스가 없습니다. "}
          <code>npm run collect</code>
          {" 를 먼저 실행하세요."}
        </Notice>
      )}

      {open.length > 0 && <CaseList cases={open} />}
    </>
  );
}
