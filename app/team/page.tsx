/**
 * 팀 — 팀원, 초대 코드, 내 계정.
 *
 * 이 화면이 "누가 우리 팀인가" 의 정본이다. 캘린더의 담당자 목록과 주간 정리의
 * 사람별 섹션이 여기 있는 사람들을 쓴다.
 */
import { requireUser } from "../../lib/appAuth.ts";
import { getTeam, openDb } from "../../lib/db.ts";
import { listTeamMembers } from "../../lib/users.ts";
import { COLOR, Notice, PageHeader, TEXT } from "../ui.tsx";
import { TeamPanel, type TeamMemberView } from "./TeamPanel.tsx";

export const dynamic = "force-dynamic";

interface Loaded {
  teamName: string;
  inviteCode: string;
  members: TeamMemberView[];
}

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const me = await requireUser("/team");
  const params = await searchParams;

  let loaded: Loaded | null = null;
  let loadError: string | null = null;

  if (me.teamId !== "") {
    const db = await openDb();
    try {
      const team = await getTeam(db, me.teamId);
      const members = await listTeamMembers(db, me.teamId);
      loaded = {
        teamName: team?.team_name ?? "",
        // 초대 코드는 owner 에게만 보인다(가입을 여닫는 열쇠).
        inviteCode: me.role === "owner" ? (team?.invite_code ?? "") : "",
        members: members.map((m) => ({
          userId: m.userId,
          loginId: m.loginId,
          displayName: m.displayName,
          role: m.role,
          joinedAt: m.joinedAt,
          lastLoginAt: m.lastLoginAt,
          hasJira: m.jiraAccountId !== "",
        })),
      };
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    } finally {
      await db.close();
    }
  }

  return (
    <>
      <PageHeader title="팀">
        팀원과 초대 코드, 그리고 내 계정을 관리합니다. 브로드컴 공용 계정은{" "}
        <a href="/settings/account" style={{ color: COLOR.accent }}>
          브로드컴 계정
        </a>{" "}
        화면에서 바꿉니다.
      </PageHeader>

      {params.noteam !== undefined && (
        <Notice tone="warn">
          아직 어느 팀에도 속해 있지 않습니다. 팀 관리자에게 초대 코드를 받아 다시 가입하거나,
          관리자가 이 화면에서 연결해 주어야 합니다.
        </Notice>
      )}
      {params.forbidden !== undefined && (
        <Notice tone="warn">그 화면은 팀 관리자(owner)만 열 수 있습니다.</Notice>
      )}
      {loadError !== null && (
        <p style={{ color: COLOR.waitUs, fontSize: TEXT.base }}>{`불러오지 못했습니다: ${loadError}`}</p>
      )}

      <TeamPanel
        teamId={me.teamId}
        teamName={loaded?.teamName ?? ""}
        initialInviteCode={loaded?.inviteCode ?? ""}
        members={loaded?.members ?? []}
        me={{
          userId: me.userId,
          loginId: me.loginId,
          displayName: me.displayName,
          role: me.role,
          jiraAccountId: me.jiraAccountId,
        }}
      />
    </>
  );
}
