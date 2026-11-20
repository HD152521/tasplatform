/**
 * 회원가입.
 *
 * 초대 코드가 있어야 가입된다 — 코드가 "어느 팀 사람인가" 를 가입 순간에 정한다.
 * 다만 **첫 사람**은 코드 없이 받는다. 코드는 로그인해야 보이는 값이라, 아무도
 * 없는 상태에서 요구하면 아무도 들어올 수 없다(lib/users.ts signup 주석).
 */
import { openDb } from "../../lib/db.ts";
import { countUsers } from "../../lib/users.ts";
import { COLOR } from "../ui.tsx";
import { SignUpForm } from "./SignUpForm.tsx";

export const dynamic = "force-dynamic";

async function firstRun(): Promise<boolean> {
  const db = await openDb();
  try {
    return (await countUsers(db)) === 0;
  } catch {
    // 못 읽으면 코드를 요구하는 쪽으로 기운다(안전한 기본값).
    return false;
  } finally {
    await db.close();
  }
}

export default async function SignUpPage() {
  const first = await firstRun();

  return (
    <div style={{ maxWidth: 420, margin: "8vh auto 0" }}>
      <header style={{ marginBottom: 22 }}>
        <div style={{ fontSize: 13, color: COLOR.muted, fontWeight: 500 }}>Broadcom SR Hub</div>
        <h1 style={{ fontSize: 25, fontWeight: 700, margin: "4px 0 0", letterSpacing: "-0.02em" }}>
          가입
        </h1>
        <p style={{ margin: "9px 0 0", fontSize: 13, color: COLOR.muted, lineHeight: 1.7 }}>
          {first
            ? "첫 사용자입니다. 초대 코드 없이 기본 팀의 관리자(owner)로 가입합니다."
            : "팀 초대 코드가 필요합니다. 팀 관리자에게 받으세요."}
        </p>
      </header>

      <SignUpForm firstRun={first} />
    </div>
  );
}
