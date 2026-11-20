"use client";

import { useState } from "react";
import { COLOR, Card, Notice, controlStyle } from "../ui.tsx";

interface Props {
  /** 로그인 뒤 돌아갈 곳. requireUser 가 붙여 준다. */
  readonly next: string;
  /** 아직 아무도 가입하지 않았다 — 첫 사람은 초대 코드 없이 가입한다. */
  readonly firstRun: boolean;
}

/**
 * 돌아갈 주소를 **같은 사이트 안으로만** 제한한다.
 *
 * `?next=` 는 주소창에서 오는 값이다. `//evil.example` 같은 값을 그대로 넘기면
 * 로그인 버튼이 외부로 보내는 링크가 된다(오픈 리다이렉트). 사내망이라 해도
 * 링크 한 줄로 만들어지는 함정이라 막아 둔다.
 */
function safeNext(raw: string): string {
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

export function SignInForm({ next, firstRun }: Props) {
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginId, password }),
      });
      const data = (await res.json()) as { ok?: boolean; message?: string };
      if (data.ok === true) {
        // 쿠키가 응답에 실려 왔으므로 전체 이동으로 서버가 다시 그리게 한다.
        window.location.href = safeNext(next);
        return;
      }
      setError(data.message ?? "로그인하지 못했습니다.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ padding: 22 }}>
      {firstRun && (
        <Notice tone="warn">
          아직 가입한 사람이 없습니다. <strong>처음 가입하는 사람</strong>은 초대 코드 없이
          기본 팀의 관리자(owner)가 됩니다.
        </Notice>
      )}

      <form onSubmit={submit}>
        <label style={labelStyle}>아이디</label>
        <input
          value={loginId}
          onChange={(e) => setLoginId(e.target.value)}
          autoComplete="username"
          autoFocus
          style={{ ...controlStyle, width: "100%", cursor: "text", marginBottom: 14 }}
        />

        <label style={labelStyle}>비밀번호</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          style={{ ...controlStyle, width: "100%", cursor: "text", marginBottom: 18 }}
        />

        {error !== "" && (
          <p style={{ color: COLOR.waitUs, fontSize: 13, margin: "0 0 14px", lineHeight: 1.6 }}>
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || loginId.trim() === "" || password === ""}
          style={{
            ...controlStyle,
            width: "100%",
            background: COLOR.accent,
            color: "#ffffff",
            border: "none",
            padding: "11px 13px",
            fontWeight: 600,
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? "확인 중…" : "로그인"}
        </button>
      </form>

      <div style={{
        marginTop: 18, paddingTop: 16, borderTop: `1px solid ${COLOR.divider}`,
        fontSize: 13, color: COLOR.muted,
      }}>
        계정이 없으면{" "}
        <a href="/signup" style={{ color: COLOR.accent, fontWeight: 600 }}>
          가입
        </a>
        하세요{firstRun ? "." : " (팀 초대 코드가 필요합니다)."}
      </div>

      <div style={{ marginTop: 10, fontSize: 12, color: COLOR.faint, lineHeight: 1.7 }}>
        브로드컴 포털(공용 계정) 로그인은{" "}
        <a href="/login" style={{ color: COLOR.faint, textDecoration: "underline" }}>
          /login
        </a>{" "}
        입니다. 이 화면과 다릅니다.
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
