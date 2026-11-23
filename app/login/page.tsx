import { requireUser } from "../../lib/appAuth.ts";
import { getSessionStatus } from "../../lib/sessionFile.ts";
import { openDb } from "../../lib/db.ts";
import { getPortalCredentialsMeta } from "../../lib/portalCredentials.ts";
import { readLoginGuard, type LoginGuardState } from "../../lib/loginGuard.ts";
import { COLOR, Card } from "../ui.tsx";
import { LoginForm } from "./LoginForm.tsx";

export const dynamic = "force-dynamic";

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString("ko-KR");
}

/**
 * 저장된 계정과 잠금 방지 상태.
 *
 * DB 를 못 열어도 로그인 화면 자체는 떠야 한다 — 로그인은 DB 없이도 되는 동작이고,
 * 여기서 터지면 사람이 세션을 복구할 유일한 창구가 닫힌다.
 */
async function readAccount(teamId: string): Promise<{
  username: string;
  hasStored: boolean;
  guard: LoginGuardState | null;
}> {
  try {
    const db = await openDb();
    try {
      const meta = await getPortalCredentialsMeta(db, teamId);
      return {
        username: meta.username,
        hasStored: meta.hasPassword,
        guard: await readLoginGuard(db, teamId),
      };
    } finally {
      await db.close();
    }
  } catch {
    return { username: "", hasStored: false, guard: null };
  }
}

export default async function LoginPage() {
  // 로그인한 사람만. 문을 페이지마다 두는 이유는 lib/appAuth.ts 머리말에 있다.
  const me = await requireUser("/login");
  // 포털 세션·자격·잠금은 **팀별**이다. 팀이 없으면 기본 팀으로 떨어진다.
  const teamId = me.teamId === "" ? undefined : me.teamId;
  const session = getSessionStatus(teamId);
  const account = await readAccount(me.teamId);
  const guard = account.guard;

  return (
    <div style={{ maxWidth: 460, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, margin: "0 0 6px", letterSpacing: "-0.01em" }}>
        Broadcom 로그인
      </h1>
      <p style={{ color: COLOR.muted, fontSize: 13, lineHeight: 1.7, margin: "0 0 20px" }}>
        수집기가 쓸 세션을 갱신합니다. 입력한 비밀번호는 저장되지 않고
        로그인에 한 번 쓰인 뒤 사라집니다.
      </p>

      <Card style={{ padding: "14px 16px", marginBottom: 18, fontSize: 13, lineHeight: 1.7 }}>
        {!session.exists ? (
          <span style={{ color: COLOR.warn }}>저장된 세션이 없습니다. 로그인이 필요합니다.</span>
        ) : session.expired ? (
          <span style={{ color: COLOR.waitUs }}>
            세션이 만료되었습니다
            {session.expiresAt !== null && <> (만료 {formatWhen(session.expiresAt)})</>}.
          </span>
        ) : (
          /*
            ## "유효합니다" 라고 단정하지 않는다

            이 판정은 **쿠키에 적힌 만료 시각만** 읽은 것이다. 포털에 물어본 것이
            아니다. 공용 계정 하나를 웹과 수집기가 같이 쓰므로 수집기가 다시 로그인하면
            앞선 쿠키는 **적힌 시각 전에도** 무효가 된다.

            전에는 이 화면이 초록색으로 "세션이 유효합니다" 라고 말하는데 SR 작성 화면은
            "세션이 만료되었습니다" 라고 해서, 둘 중 무엇을 믿어야 할지 알 수 없었다.
            아는 것만 말한다 — 적힌 시각은 이것이고, 그게 살아 있다는 보장은 아니다.
          */
          <span style={{ color: COLOR.ok }}>
            세션이 저장돼 있습니다
            {session.expiresAt !== null && <> — 적힌 만료 시각 {formatWhen(session.expiresAt)}</>}.
            <span style={{ color: COLOR.muted }}>
              {" "}포털이 먼저 끊었을 수도 있어, 다른 화면에서 거부되면 여기서 다시 로그인하세요.
            </span>
          </span>
        )}
        <div style={{ color: COLOR.muted, marginTop: 6 }}>
          {session.deviceTrusted
            ? "이 서버는 신뢰된 기기로 등록돼 있어 보통 OTP를 묻지 않습니다."
            : "기기 신뢰 표식이 없어 OTP를 요구할 수 있습니다."}
        </div>
      </Card>

      {guard !== null && guard.blocked && (
        <Card style={{
          padding: "14px 16px", marginBottom: 18, fontSize: 13, lineHeight: 1.7,
          background: COLOR.waitUsBg, borderColor: `${COLOR.waitUs}33`, color: COLOR.waitUs,
        }}>
          <b>저장된 비밀번호로는 자동 로그인을 멈춘 상태입니다 (계정 잠금 방지)</b>
          <div style={{ marginTop: 4 }}>
            {guard.lastReason || "자격이 거절되었습니다"}
            {guard.blockedAt !== "" && <> · {new Date(guard.blockedAt).toLocaleString("ko-KR")} 부터 멈춤</>}
          </div>
          <div style={{ marginTop: 6, color: COLOR.body }}>
            여기서 <b>새 비밀번호로 로그인</b>하면(아래 체크박스를 켠 채) 저장된 값도 함께
            바뀌어 자동 로그인이 바로 복구됩니다.
          </div>
        </Card>
      )}

      <Card style={{ padding: "20px 22px" }}>
        <LoginForm storedUsername={account.username} hasStored={account.hasStored} />
      </Card>
    </div>
  );
}
