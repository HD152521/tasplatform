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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const mismatch = again !== "" && password !== again;
  const ready =
    loginId.trim() !== "" &&
    displayName.trim() !== "" &&
    password.length >= 8 &&
    !mismatch &&
    again !== "" &&
    (firstRun || inviteCode.trim() !== "");

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginId, displayName, password, inviteCode }),
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
            <label style={labelStyle}>팀 초대 코드</label>
            <input
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
              placeholder="ABCDE-FGHIJ"
              style={{
                ...controlStyle,
                width: "100%",
                cursor: "text",
                marginBottom: 18,
                fontFamily: "ui-monospace, Consolas, monospace",
                letterSpacing: "0.04em",
              }}
            />
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

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: COLOR.body,
  marginBottom: 6,
};
