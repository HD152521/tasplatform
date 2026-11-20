/**
 * 브로드컴 공용 계정 설정.
 *
 * 왜 이 화면이 생겼나: 이 계정은 비밀번호를 주기적으로 바꾸는데, 값이 `.env` 에만 있어서
 * 회전마다 사람이 사본 세 군데(작업 PC·수집기 VM·드롭릿)를 고치고 재배포해야 했다.
 * 한 곳을 빠뜨리면 그 프로세스가 옛 비밀번호로 계속 로그인을 시도해 **계정이 잠긴다.**
 * 여기서 한 번 저장하면 웹과 수집기가 같은 값을 본다.
 */
import { requireTeamUser } from "../../../lib/appAuth.ts";
import { openDb } from "../../../lib/db.ts";
import {
  getPortalCredentialsMeta, type PortalCredentialsMeta,
} from "../../../lib/portalCredentials.ts";
import { failLimit, readLoginGuard, type LoginGuardState } from "../../../lib/loginGuard.ts";
import { hasSecretKey } from "../../../lib/secretBox.ts";
import { COLOR } from "../../ui.tsx";
import { AccountForm } from "./AccountForm.tsx";

export const dynamic = "force-dynamic";

interface Initial {
  credentials: PortalCredentialsMeta;
  guard: LoginGuardState;
}

async function readInitial(): Promise<Initial> {
  const db = await openDb();
  try {
    return { credentials: await getPortalCredentialsMeta(db), guard: await readLoginGuard(db) };
  } finally {
    await db.close();
  }
}

function browserLoginDisabled(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.SR_DISABLE_BROWSER_LOGIN ?? "").trim());
}

export default async function AccountSettingsPage() {
  // 팀 공용 계정이므로 **팀에 속한 사람**만 본다. owner 로 좁히지 않는 이유: 비밀번호가
  // 회전된 날 계정을 고쳐야 하는 사람이 owner 가 아닐 수 있고, 그때 막히면 수집이 멈춘
  // 채로 기다리게 된다(그 비용이 더 크다).
  await requireTeamUser("/settings/account");

  let initial: Initial | null = null;
  let loadError: string | null = null;
  try {
    initial = await readInitial();
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  return (
    <>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>
          브로드컴 계정
        </h1>
        <p style={{ margin: "7px 0 0", fontSize: 13, color: COLOR.muted, lineHeight: 1.7 }}>
          수집기가 자동 로그인에 쓰는 공용 계정입니다. 비밀번호를 바꿨으면 여기서 저장하면
          됩니다 — 서버 파일(.env)을 고치거나 재배포할 필요가 없습니다. 비밀번호는 암호화해
          저장하고 화면에 다시 표시하지 않습니다.
        </p>
      </header>

      {loadError !== null || initial === null ? (
        <p style={{ color: COLOR.waitUs, fontSize: 13 }}>{`불러오지 못했습니다: ${loadError}`}</p>
      ) : (
        <AccountForm
          initialCredentials={initial.credentials}
          initialGuard={initial.guard}
          failLimit={failLimit()}
          keyPresent={hasSecretKey()}
          browserless={browserLoginDisabled()}
        />
      )}
    </>
  );
}
