import { DEFAULT_TEAM_ID } from "../../lib/config.ts";
import { listTeams, openDb, type TeamRow } from "../../lib/db.ts";
import { listIntegrations, type TeamIntegrationMeta } from "../../lib/teamIntegration.ts";
import { COLOR } from "../ui.tsx";
import { SettingsForm } from "./SettingsForm.tsx";

// DB 를 매 요청 읽어야 하므로 캐싱하지 않는다.
export const dynamic = "force-dynamic";

function readInitial(): { teams: TeamRow[]; integrations: TeamIntegrationMeta[] } {
  const db = openDb();
  try {
    return { teams: listTeams(db), integrations: listIntegrations(db, DEFAULT_TEAM_ID) };
  } finally {
    db.close();
  }
}

export default function SettingsPage() {
  let teams: TeamRow[] = [];
  let integrations: TeamIntegrationMeta[] = [];
  let loadError: string | null = null;

  try {
    ({ teams, integrations } = readInitial());
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  return (
    <>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>연동 설정</h1>
        <p style={{ margin: "7px 0 0", fontSize: 13, color: COLOR.muted }}>
          팀 단위로 Jira 등 외부 API 자격을 등록합니다. 토큰은 암호화해 저장하고 화면에는 표시하지 않습니다.
        </p>
      </header>

      {loadError !== null ? (
        <p style={{ color: COLOR.waitUs, fontSize: 13 }}>{`불러오지 못했습니다: ${loadError}`}</p>
      ) : (
        <SettingsForm initialTeamId={DEFAULT_TEAM_ID} teams={teams} initialIntegrations={integrations} />
      )}
    </>
  );
}
