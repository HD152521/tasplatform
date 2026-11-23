import { requireUser } from "../../lib/appAuth.ts";
import { listCasesSplit, countSummaries, type CaseListRow } from "../../lib/queries.ts";
import { CaseList } from "../CaseList.tsx";
import { Card, COLOR, Notice, PageHeader, SPACE, TEXT } from "../ui.tsx";
import { AutoPublishKick } from "./AutoPublishKick.tsx";

export const dynamic = "force-dynamic";

export default async function ClosedCasesPage() {
  // 로그인한 사람만. 문을 페이지마다 두는 이유는 lib/appAuth.ts 머리말에 있다.
  const me = await requireUser("/closed");
  let closed: CaseListRow[] = [];
  let summaries = 0;
  let loadError: string | null = null;

  try {
  // **그 사람과 그 팀 것만.** 전에는 팀을 안 걸러 다른 팀 케이스가 섞였고, 미읽음은
  // 팀이 공유해 한 사람이 열면 모두의 배지가 사라졌다(lib/schema.ts case_reads_user).
    closed = (
      await listCasesSplit({
        teamId: me.teamId === "" ? undefined : me.teamId,
        userId: me.userId,
      })
    ).closed;
    summaries = await countSummaries();
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  return (
    <>
      <PageHeader title="종료 케이스">
        {`최근 3개월 · ${closed.length}건`}
        {summaries > 0 && (
          <>
            {" · 정리본 "}
            <b style={{ color: COLOR.ok }}>{summaries}</b>
            {"건 작성됨"}
          </>
        )}
        {"  ·  케이스를 열면 원문과 정리하기를 볼 수 있습니다"}
      </PageHeader>

      {/*
        끝난 SR 의 정리 문서를 자동으로 올린다. 이 화면이 그 방아쇠다 — 웹은 스스로
        깨어나지 않으므로(app/api/autopublish 머리말). 올릴 것이 없으면 아무것도 그리지
        않는다.
      */}
      <AutoPublishKick />

      {loadError !== null && <Notice tone="error">DB를 읽지 못했습니다: {loadError}</Notice>}

      {loadError === null && closed.length === 0 && (
        <Card style={{ padding: `${SPACE.xl}px ${SPACE.xl}px`, fontSize: TEXT.base, lineHeight: 1.8 }}>
          <b>아직 종료 케이스가 없습니다.</b>
          <div style={{ color: COLOR.muted, marginTop: SPACE.sm }}>
            {"수집이 돌면 최근 3개월 내 종료된 케이스가 여기에 쌓입니다."}
          </div>
        </Card>
      )}

      {/* 종료 케이스는 '새 답변' 개념이 의미 없으므로 그 필터를 숨긴다. */}
      {closed.length > 0 && <CaseList cases={closed} showUnread={false} closed />}
    </>
  );
}
