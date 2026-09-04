import { listRuns, openDb } from "../../lib/db.ts";
import { getSessionStatus } from "../../lib/sessionFile.ts";
import type { RunRow, RunStatus } from "../../lib/types.ts";
import { Badge, COLOR, Card, MONO_STACK, Notice, RADIUS, formatStamp } from "../ui.tsx";

// SQLite 를 매 요청 읽어야 하므로 캐싱하지 않는다.
export const dynamic = "force-dynamic";

const STATUS: Record<RunStatus, { label: string; fg: string; bg: string }> = {
  success: { label: "정상", fg: COLOR.ok, bg: COLOR.okBg },
  session_expired: { label: "세션 만료", fg: COLOR.waitUs, bg: COLOR.waitUsBg },
  failed: { label: "실패", fg: COLOR.waitUs, bg: COLOR.waitUsBg },
};

function readRuns(): RunRow[] {
  const db = openDb();
  try {
    return listRuns(db, 30);
  } finally {
    db.close();
  }
}

function formatTime(iso: string | null): string {
  if (iso === null) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : formatStamp(d.getTime());
}

export default function LogsPage() {
  let runs: RunRow[] = [];
  let loadError: string | null = null;

  try {
    runs = readRuns();
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  const session = getSessionStatus();
  const latest = runs[0];
  const healthy = latest !== undefined && latest.status === "success";

  const success = runs.filter((r) => r.status === "success").length;
  const rate = runs.length === 0 ? null : Math.round((success / runs.length) * 100);
  const replies = runs.reduce((n, r) => n + (r.status === "success" ? r.new_threads : 0), 0);

  return (
    <>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>수집 상태</h1>
        <p style={{ margin: "7px 0 0", fontSize: 13, color: COLOR.muted }}>
          예약 실행으로 케이스를 주기적으로 가져옵니다.
        </p>
      </header>

      {loadError !== null && <Notice tone="error">DB를 읽지 못했습니다: {loadError}</Notice>}

      {loadError === null && latest === undefined && (
        <Notice tone="warn">
          {"수집 기록이 없습니다. "}
          <code>npm run collect</code>
          {" 를 먼저 실행하세요."}
        </Notice>
      )}

      {/* 지금 이 데이터를 믿어도 되는지를 한 줄로 먼저 말한다. */}
      {latest !== undefined && (
        <Notice tone={healthy ? "ok" : latest.status === "session_expired" ? "warn" : "error"}>
          <b style={{ fontSize: 14 }}>
            {healthy
              ? "정상 수집 중"
              : latest.status === "session_expired"
                ? "세션이 만료되어 마지막 수집이 실패했습니다"
                : "마지막 수집이 실패했습니다"}
          </b>
          <div style={{ marginTop: 4 }}>
            {healthy
              ? `마지막 실행 ${formatTime(latest.started_at)}` +
                (session.expiresAt !== null ? ` · 세션은 ${formatTime(new Date(session.expiresAt).toISOString())}까지 유효합니다` : "")
              : "아래 건수는 최신이 아닙니다. 새 답변이 없다는 뜻이 아닙니다."}
          </div>
          {!healthy && (
            <div style={{ marginTop: 10 }}>
              <a href="/login" style={{
                display: "inline-block", padding: "8px 14px", fontSize: 13, fontWeight: 600,
                color: "#ffffff", background: COLOR.waitUs, borderRadius: RADIUS.control,
                textDecoration: "none",
              }}>
                다시 로그인
              </a>
            </div>
          )}
        </Notice>
      )}

      {runs.length > 0 && (
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: 12, margin: "0 0 24px",
        }}>
          <Stat label="최근 수집 성공률" value={rate === null ? "-" : `${rate}%`} note={`최근 ${runs.length}회 기준`} />
          <Stat label="누적 새 답변" value={String(replies)} note="이 이력 범위 안에서" tone={replies > 0 ? COLOR.waitUs : undefined} />
          <Stat
            label="마지막 실행"
            value={formatTime(latest === undefined ? null : latest.started_at)}
            note={latest === undefined ? "" : STATUS[latest.status].label}
          />
        </div>
      )}

      {runs.length > 0 && (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 11 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>실행 이력</h2>
            <span style={{ fontSize: 12, color: COLOR.faint }}>{`최근 ${runs.length}회`}</span>
          </div>

          <Card style={{ overflow: "hidden" }}>
            <Row header />
            {runs.map((run, i) => {
              const tone = STATUS[run.status] ?? STATUS.failed;
              const usable = run.status === "success";
              return (
                <Row
                  key={run.run_id}
                  last={i === runs.length - 1}
                  dim={!usable}
                  cells={[
                    <span key="t" style={{ fontFamily: MONO_STACK, fontSize: 12, color: "#4b5563" }}>
                      {formatTime(run.started_at)}
                    </span>,
                    <Badge key="s" fg={tone.fg} bg={tone.bg}>{tone.label}</Badge>,
                    <span key="e" style={{
                      fontSize: 12, color: COLOR.faint,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {run.error ?? ""}
                    </span>,
                    <Num key="c" value={usable ? String(run.cases_seen) : "—"} dim={!usable} />,
                    <Num key="g" value={usable ? String(run.cases_changed) : "—"} dim={!usable} />,
                    <Num
                      key="r"
                      value={usable ? String(run.new_threads) : "—"}
                      dim={!usable}
                      strong={usable && run.new_threads > 0}
                    />,
                  ]}
                />
              );
            })}
          </Card>

          <p style={{ margin: "14px 2px 0", fontSize: 12, color: COLOR.faint, lineHeight: 1.75 }}>
            {"조회하지 못한 회차는 건수를 "}
            <span style={{ fontFamily: MONO_STACK, color: COLOR.muted }}>—</span>
            {" 로 표시합니다. "}
            <b style={{ color: COLOR.muted, fontWeight: 600 }}>0</b>
            {"으로 적으면 “새 답변이 없다”는 뜻으로 읽히기 때문입니다."}
          </p>
        </>
      )}
    </>
  );
}

const GRID = "150px 106px 1fr 78px 78px 92px";

function Row({
  cells, header = false, dim = false, last = false,
}: { cells?: React.ReactNode[]; header?: boolean; dim?: boolean; last?: boolean }) {
  if (header) {
    return (
      <div style={{
        display: "grid", gridTemplateColumns: GRID, gap: 12, padding: "10px 18px",
        borderBottom: `1px solid ${COLOR.divider}`, background: "#fafbfc",
        fontSize: 11, color: COLOR.faint, letterSpacing: "0.02em",
      }}>
        <span>시각</span><span>결과</span><span>비고</span>
        <span style={{ textAlign: "right" }}>케이스</span>
        <span style={{ textAlign: "right" }}>변경</span>
        <span style={{ textAlign: "right" }}>새 답변</span>
      </div>
    );
  }
  return (
    <div style={{
      display: "grid", gridTemplateColumns: GRID, gap: 12, alignItems: "center",
      padding: "12px 18px",
      borderBottom: last ? "none" : `1px solid ${COLOR.divider}`,
      background: dim ? "#fffdfb" : COLOR.surface,
    }}>
      {cells}
    </div>
  );
}

function Num({ value, dim, strong }: { value: string; dim: boolean; strong?: boolean }) {
  return (
    <span style={{
      fontFamily: MONO_STACK, fontSize: 13, textAlign: "right",
      color: dim ? "#c7ccd4" : strong === true ? COLOR.waitUs : "#4b5563",
      fontWeight: strong === true ? 700 : 400,
    }}>
      {value}
    </span>
  );
}

function Stat({ label, value, note, tone }: { label: string; value: string; note: string; tone?: string }) {
  return (
    <Card style={{ padding: "15px 17px" }}>
      <div style={{ fontSize: 11, color: COLOR.faint, letterSpacing: "0.02em" }}>{label}</div>
      <div style={{
        fontFamily: MONO_STACK, fontSize: 22, fontWeight: 600, marginTop: 5,
        letterSpacing: "-0.02em", color: tone ?? COLOR.ink,
      }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: COLOR.faint, marginTop: 3 }}>{note}</div>
    </Card>
  );
}
