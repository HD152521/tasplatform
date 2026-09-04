import { getSessionStatus } from "../../lib/sessionFile.ts";
import { COLOR, Card } from "../ui.tsx";
import { LoginForm } from "./LoginForm.tsx";

export const dynamic = "force-dynamic";

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString("ko-KR");
}

export default function LoginPage() {
  const session = getSessionStatus();

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
          <span style={{ color: COLOR.ok }}>
            세션이 유효합니다
            {session.expiresAt !== null && <> — {formatWhen(session.expiresAt)} 까지</>}.
          </span>
        )}
        <div style={{ color: COLOR.muted, marginTop: 6 }}>
          {session.deviceTrusted
            ? "이 서버는 신뢰된 기기로 등록돼 있어 보통 OTP를 묻지 않습니다."
            : "기기 신뢰 표식이 없어 OTP를 요구할 수 있습니다."}
        </div>
      </Card>

      <Card style={{ padding: "20px 22px" }}>
        <LoginForm />
      </Card>
    </div>
  );
}
