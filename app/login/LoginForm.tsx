"use client";

import { useState } from "react";
import { COLOR } from "../ui.tsx";

type Result =
  | { status: "done" }
  | { status: "otp_required"; flowId: string; hint: string }
  | { status: "error"; message: string };

type Stage = "credentials" | "otp" | "done";

const inputStyle = {
  width: "100%", padding: "10px 12px", fontSize: 15,
  border: `1px solid ${COLOR.line}`, borderRadius: 8,
  boxSizing: "border-box" as const, fontFamily: "inherit",
};

const labelStyle = {
  display: "block", fontSize: 13, fontWeight: 600,
  marginBottom: 6, color: COLOR.ink,
};

async function post(url: string, body: unknown): Promise<Result> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Result;
}

export function LoginForm() {
  const [stage, setStage] = useState<Stage>("credentials");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [flowId, setFlowId] = useState("");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function apply(result: Result): void {
    if (result.status === "done") {
      setStage("done");
      setPassword("");
      return;
    }
    if (result.status === "otp_required") {
      setFlowId(result.flowId);
      setHint(result.hint);
      setPassword(""); // 더 이상 필요 없다. 화면에서도 지운다.
      setStage("otp");
      return;
    }
    setError(result.message);
  }

  async function submitCredentials(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      apply(await post("/api/login/start", { username, password }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitOtp(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      apply(await post("/api/login/otp", { flowId, code }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function restart(): Promise<void> {
    if (flowId !== "") await post("/api/login/cancel", { flowId }).catch(() => undefined);
    setStage("credentials");
    setFlowId("");
    setCode("");
    setError("");
  }

  if (stage === "done") {
    return (
      <div style={{
        background: COLOR.okBg, color: COLOR.ok, border: `1px solid ${COLOR.ok}33`,
        borderRadius: 8, padding: "16px 18px", lineHeight: 1.7, fontSize: 14,
      }}>
        <b>로그인 완료</b>
        <div style={{ marginTop: 4 }}>
          세션이 저장됐습니다. 이제 수집기가 재로그인 없이 동작합니다.
        </div>
        <a href="/" style={{ color: COLOR.accent, textDecoration: "none", display: "inline-block", marginTop: 10 }}>
          케이스 목록으로 →
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={stage === "otp" ? submitOtp : submitCredentials}>
      {error !== "" && (
        <div style={{
          background: COLOR.waitUsBg, color: COLOR.waitUs, border: `1px solid ${COLOR.waitUs}33`,
          borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13, lineHeight: 1.6,
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>
          {error}
        </div>
      )}

      {stage === "credentials" ? (
        <>
          <div style={{ marginBottom: 14 }}>
            <label htmlFor="u" style={labelStyle}>Broadcom 아이디</label>
            <input
              id="u" type="email" autoComplete="username" required
              value={username} onChange={(e) => setUsername(e.target.value)}
              placeholder="name@example.com" style={inputStyle} disabled={busy}
            />
          </div>
          <div style={{ marginBottom: 18 }}>
            <label htmlFor="p" style={labelStyle}>비밀번호</label>
            <input
              id="p" type="password" autoComplete="current-password" required
              value={password} onChange={(e) => setPassword(e.target.value)}
              style={inputStyle} disabled={busy}
            />
          </div>
        </>
      ) : (
        <>
          <div style={{
            background: COLOR.waitThemBg, color: COLOR.waitThem, borderRadius: 8,
            padding: "10px 14px", marginBottom: 16, fontSize: 13, lineHeight: 1.6,
          }}>
            {hint}
          </div>
          <div style={{ marginBottom: 18 }}>
            <label htmlFor="c" style={labelStyle}>인증 코드</label>
            <input
              id="c" type="text" inputMode="numeric" autoComplete="one-time-code"
              required autoFocus value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="000000"
              style={{ ...inputStyle, letterSpacing: "0.3em", fontSize: 18 }}
              disabled={busy}
            />
          </div>
        </>
      )}

      <button
        type="submit" disabled={busy}
        style={{
          width: "100%", padding: "11px 16px", fontSize: 15, fontWeight: 600,
          color: "#fff", background: busy ? COLOR.muted : COLOR.accent,
          border: "none", borderRadius: 8, cursor: busy ? "default" : "pointer",
          fontFamily: "inherit",
        }}
      >
        {busy
          ? "처리 중… (브라우저 인증에 20초 이상 걸릴 수 있습니다)"
          : stage === "otp" ? "코드 확인" : "로그인"}
      </button>

      {stage === "otp" && !busy && (
        <button
          type="button" onClick={restart}
          style={{
            width: "100%", marginTop: 10, padding: "9px 16px", fontSize: 13,
            color: COLOR.muted, background: "transparent",
            border: `1px solid ${COLOR.line}`, borderRadius: 8, cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          처음부터 다시
        </button>
      )}
    </form>
  );
}
