import { listCasesSplit, countSummaries, type CaseListRow } from "../../lib/queries.ts";
import { CaseList } from "../CaseList.tsx";
import { COLOR, Card, Notice } from "../ui.tsx";

export const dynamic = "force-dynamic";

export default function ClosedCasesPage() {
  let closed: CaseListRow[] = [];
  let summaries = 0;
  let loadError: string | null = null;

  try {
    closed = listCasesSplit().closed;
    summaries = countSummaries();
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  return (
    <>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>
          종료 케이스
        </h1>
        <p style={{ margin: "7px 0 0", fontSize: 13, color: COLOR.muted }}>
          {`최근 3개월 · ${closed.length}건`}
          {summaries > 0 && (
            <>
              {" · 정리본 "}
              <b style={{ color: COLOR.ok }}>{summaries}</b>
              {"건 작성됨"}
            </>
          )}
          {"  ·  케이스를 열면 원문과 정리하기를 볼 수 있습니다"}
        </p>
      </header>

      {loadError !== null && <Notice tone="error">DB를 읽지 못했습니다: {loadError}</Notice>}

      {loadError === null && closed.length === 0 && (
        <Card style={{ padding: "20px 22px", fontSize: 13.5, lineHeight: 1.8 }}>
          <b>아직 종료 케이스가 없습니다.</b>
          <div style={{ color: COLOR.muted, marginTop: 8 }}>
            {"수집이 돌면 최근 3개월 내 종료된 케이스가 여기에 쌓입니다."}
          </div>
        </Card>
      )}

      {/* 종료 케이스는 '새 답변' 개념이 의미 없으므로 그 필터를 숨긴다. */}
      {closed.length > 0 && <CaseList cases={closed} showUnread={false} closed />}
    </>
  );
}
