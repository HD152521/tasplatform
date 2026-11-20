/**
 * 앱 로그인.
 *
 * ⚠ `/login` 과 다른 화면이다. 거기는 **브로드컴 포털**(공용 계정) 로그인이고
 * 여기는 이 도구를 쓰는 **사람**의 로그인이다. 두 화면의 제목이 그 차이를 말한다.
 */
import { openDb } from "../../lib/db.ts";
import { countUsers } from "../../lib/users.ts";
import { COLOR } from "../ui.tsx";
import { SignInForm } from "./SignInForm.tsx";

export const dynamic = "force-dynamic";

async function noUsersYet(): Promise<boolean> {
  const db = await openDb();
  try {
    return (await countUsers(db)) === 0;
  } catch {
    // DB 를 못 읽어도 화면은 떠야 한다. 안내 문구 하나가 덜 나올 뿐이다.
    return false;
  } finally {
    await db.close();
  }
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = typeof params.next === "string" ? params.next : "/";
  const first = await noUsersYet();

  return (
    <div style={{ maxWidth: 420, margin: "8vh auto 0" }}>
      <header style={{ marginBottom: 22 }}>
        <div style={{ fontSize: 13, color: COLOR.muted, fontWeight: 500 }}>Broadcom SR Hub</div>
        <h1 style={{ fontSize: 25, fontWeight: 700, margin: "4px 0 0", letterSpacing: "-0.02em" }}>
          로그인
        </h1>
        <p style={{ margin: "9px 0 0", fontSize: 13, color: COLOR.muted, lineHeight: 1.7 }}>
          이 도구를 쓰는 사람의 계정입니다. 브로드컴 포털 계정과는 별개입니다.
        </p>
      </header>

      <SignInForm next={next} firstRun={first} />
    </div>
  );
}
