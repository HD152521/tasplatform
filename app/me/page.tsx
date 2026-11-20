/**
 * 내 설정.
 *
 * 팀 설정(`/team`)과 갈라 둔다. 바꾸는 사람도 빈도도 다르고, 한 화면에 섞여 있으면
 * "내 이름을 고치려다 팀 이름을 고치는" 일이 생긴다(MyAccountPanel 머리말).
 *
 * 브로드컴 공용 계정은 **팀 것**이라 여기 없다 — `/settings/account` 다.
 */
import Link from "next/link";
import { requireUser } from "../../lib/appAuth.ts";
import { COLOR, Notice } from "../ui.tsx";
import { MyAccountPanel } from "./MyAccountPanel.tsx";

export const dynamic = "force-dynamic";

export default async function MyPage() {
  const me = await requireUser("/me");

  return (
    <>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>
          내 설정
        </h1>
        <p style={{ margin: "7px 0 0", fontSize: 13, color: COLOR.muted, lineHeight: 1.7 }}>
          나에게만 해당되는 것입니다. 팀 이름·초대 코드·팀원은{" "}
          <Link href="/team" style={{ color: COLOR.accent }}>팀 설정</Link>, 팀이 공유하는
          브로드컴 계정은{" "}
          <Link href="/settings/account" style={{ color: COLOR.accent }}>브로드컴 계정</Link>{" "}
          화면입니다.
        </p>
      </header>

      {me.teamId === "" && (
        <Notice tone="warn">
          아직 어느 팀에도 속해 있지 않습니다. 팀에 속하지 않으면 캘린더·브로드컴 계정을 쓸 수
          없습니다 — 팀 관리자에게 초대 코드를 받아 주세요.
        </Notice>
      )}

      <MyAccountPanel
        loginId={me.loginId}
        displayName={me.displayName}
        jiraAccountId={me.jiraAccountId}
        teamName={me.teamName}
        role={me.role}
      />
    </>
  );
}
