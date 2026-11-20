"use client";

import { useState } from "react";
import { COLOR, Card, controlStyle } from "../ui.tsx";

interface Props {
  readonly firstRun: boolean;
}

export function SignUpForm({ firstRun }: Props) {
  const [loginId, setLoginId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  /**
   * 팀에 어떻게 들어가나.
   *
   * 브로드컴 공용 계정이 **팀에 귀속**되므로, 다른 계정을 쓰는 조직이 들어오면 새 팀이
   * 먼저 있어야 한다. 그게 없으면 남의 팀에 끼어 들어가 그 팀 계정을 보게 된다.
   */
  const [mode, setMode] = useState<"invite" | "create">("invite");
  const [teamName, setTeamName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const mismatch = again !== "" && password !== again;
  const teamReady = firstRun || (mode === "create" ? teamName.trim() !== "" : inviteCode.trim() !== "");
  const ready =
    loginId.trim() !== "" &&
    displayName.trim() !== "" &&
    password.length >= 8 &&
    !mismatch &&
    again !== "" &&
    teamReady;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginId, displayName, password, inviteCode, mode, teamName }),
      });
      const data = (await res.json()) as { ok?: boolean; message?: string };
      if (data.ok === true) {
        // 가입 응답이 세션 쿠키를 심었다. 전체 이동으로 서버가 다시 그리게 한다.
        window.location.href = "/";
        return;
      }
      setError(data.message ?? "가입하지 못했습니다.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ padding: 22 }}>
      <form onSubmit={submit}>
        <label style={labelStyle}>아이디</label>
        <input
          value={loginId}
          onChange={(e) => setLoginId(e.target.value)}
          autoComplete="username"
          autoFocus
          placeholder="영문 소문자·숫자와 . _ - @"
          style={{ ...controlStyle, width: "100%", cursor: "text", marginBottom: 14 }}
        />

        <label style={labelStyle}>이름</label>
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          autoComplete="name"
          placeholder="일정·기록에 표시될 이름"
          style={{ ...controlStyle, width: "100%", cursor: "text", marginBottom: 14 }}
        />

        <label style={labelStyle}>비밀번호 (8자 이상)</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          style={{ ...controlStyle, width: "100%", cursor: "text", marginBottom: 14 }}
        />

        <label style={labelStyle}>비밀번호 확인</label>
        <input
          type="password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
          autoComplete="new-password"
          style={{
            ...controlStyle,
            width: "100%",
            cursor: "text",
            marginBottom: mismatch ? 6 : 14,
            borderColor: mismatch ? COLOR.waitUs : COLOR.field,
          }}
        />
        {mismatch && (
          <p style={{ color: COLOR.waitUs, fontSize: 12, margin: "0 0 14px" }}>
            비밀번호가 서로 다릅니다.
          </p>
        )}

        {!firstRun && (
          <>
            <label style={labelStyle}>팀</label>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <ModeButton
                active={mode === "invite"}
                onClick={() => setMode("invite")}
                title="기존 팀에 참여"
                hint="초대 코드가 있어요"
              />
              <ModeButton
                active={mode === "create"}
                onClick={() => setMode("create")}
                title="새 팀 만들기"
                hint="우리 팀 계정을 따로 씁니다"
              />
            </div>

            {mode === "invite" ? (
              <input
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                placeholder="ABCDE-FGHIJ"
                style={{
                  ...controlStyle,
                  width: "100%",
                  cursor: "text",
                  marginBottom: 6,
                  fontFamily: "ui-monospace, Consolas, monospace",
                  letterSpacing: "0.04em",
                }}
              />
            ) : (
              <input
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                placeholder="예: 데이터솔루션 2팀"
                style={{ ...controlStyle, width: "100%", cursor: "text", marginBottom: 6 }}
              />
            )}
            <p style={{ margin: "0 0 18px", fontSize: 11.5, color: COLOR.faint, lineHeight: 1.7 }}>
              {mode === "invite"
                ? "팀 관리자에게 받은 코드를 넣으세요. 그 팀의 브로드컴 계정을 함께 쓰게 됩니다."
                : "새 팀의 관리자가 됩니다. 가입 뒤 「브로드컴 계정」 화면에서 이 팀이 쓸 포털 계정을 넣어야 수집이 시작됩니다."}
            </p>
          </>
        )}

        {error !== "" && (
          <p style={{ color: COLOR.waitUs, fontSize: 13, margin: "0 0 14px", lineHeight: 1.6 }}>
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || !ready}
          style={{
            ...controlStyle,
            width: "100%",
            background: COLOR.accent,
            color: "#ffffff",
            border: "none",
            padding: "11px 13px",
            fontWeight: 600,
            opacity: busy || !ready ? 0.6 : 1,
          }}
        >
          {busy ? "가입 중…" : "가입하고 시작"}
        </button>
      </form>

      <div style={{
        marginTop: 18, paddingTop: 16, borderTop: `1px solid ${COLOR.divider}`,
        fontSize: 13, color: COLOR.muted,
      }}>
        이미 계정이 있으면{" "}
        <a href="/signin" style={{ color: COLOR.accent, fontWeight: 600 }}>
          로그인
        </a>
        하세요.
      </div>
    </Card>
  );
}

/** 참여 / 새 팀 중 하나를 고르는 큰 버튼. 라디오보다 눌러야 할 것이 분명하다. */
function ModeButton({
  active, onClick, title, hint,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1,
        textAlign: "left",
        padding: "9px 11px",
        borderRadius: 8,
        cursor: "pointer",
        fontFamily: "inherit",
        border: `1px solid ${active ? COLOR.accent : COLOR.field}`,
        background: active ? COLOR.waitThemBg : COLOR.surface,
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 600, color: active ? COLOR.accent : COLOR.ink }}>
        {title}
      </div>
      <div style={{ fontSize: 11, color: COLOR.muted, marginTop: 2 }}>{hint}</div>
    </button>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: COLOR.body,
  marginBottom: 6,
};
