/**
 * 메모장.
 *
 * 일정에 붙지 않는 글을 적는 자리다. 그런 글을 적을 데가 없어서 팀 캘린더에 억지로
 * 날짜를 붙여 적고 있었다 — 회의 내용, 조사 결과, 인수인계, 설정 값.
 *
 * 적은 글은 **사내에만 남는다.** 노션으로 올리는 것은 사람이 따로 누를 때만 나간다
 * (app/api/notes/route.ts). 저장이 외부로 새어 나가지 않는다는 것이 이 화면을 쓸 수
 * 있게 만드는 조건이다.
 */
import { requireTeamUser } from "../../lib/appAuth.ts";
import { openDb } from "../../lib/db.ts";
import { notionReady } from "../../lib/notePublish.ts";
import { listNotes, type TeamNoteView } from "../../lib/notes.ts";
import { listTeamMembers } from "../../lib/users.ts";
import { COLOR, Notice } from "../ui.tsx";
import type { MemberChip } from "../calendar/CalendarBoard.tsx";
import { NotesBoard } from "./NotesBoard.tsx";

export const dynamic = "force-dynamic";

export default async function NotesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const me = await requireTeamUser("/notes");
  const params = await searchParams;
  const focusRaw = typeof params.note === "string" ? Number(params.note) : null;

  let notes: TeamNoteView[] = [];
  let members: MemberChip[] = [];
  let loadError: string | null = null;

  const db = await openDb();
  try {
    notes = await listNotes(db, me.teamId);
    members = (await listTeamMembers(db, me.teamId)).map((m) => ({
      userId: m.userId,
      displayName: m.displayName,
      loginId: m.loginId,
      hasJira: m.jiraAccountId !== "",
    }));
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  } finally {
    await db.close();
  }

  return (
    <>
      <header style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>
          메모장
        </h1>
        <p style={{ margin: "7px 0 0", fontSize: 13, color: COLOR.muted, lineHeight: 1.7 }}>
          날짜에 걸지 않는 글을 적습니다 — 회의 내용, 조사 결과, 인수인계, 설정 값.
          같은 팀 모두에게 보이고 <strong>사내에만 남습니다.</strong> 노션으로 올리는 것은
          따로 누를 때만 나갑니다.
        </p>
      </header>

      {loadError !== null && (
        <Notice tone="error">{`메모를 불러오지 못했습니다: ${loadError}`}</Notice>
      )}

      <NotesBoard
        initialNotes={notes}
        members={members}
        notionReady={notionReady()}
        focusNoteId={focusRaw !== null && Number.isInteger(focusRaw) ? focusRaw : null}
      />
    </>
  );
}
