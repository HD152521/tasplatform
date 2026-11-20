"use client";

import { useState } from "react";
import { COLOR } from "../ui.tsx";

type Result =
  | { status: "done"; warning?: string }
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

interface Props {
  /** 지금 저장돼 있는 아이디. 비어 있으면 빈 칸으로 시작한다. */
  readonly storedUsername?: string;
  /** 자동 로그인용 비밀번호가 이미 저장돼 있는가. 체크박스 설명이 달라진다. */
  readonly hasStored?: boolean;
}

async function post(url: string, body: unknown): Promise<Result> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Result;
}

export function LoginForm({ storedUsername = "", hasStored = false }: Props) {
  const [stage, setStage] = useState<Stage>("credentials");
  const [username, setUsername] = useState(storedUsername);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [flowId, setFlowId] = useState("");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  // 기본값을 켜 둔다. 이게 꺼져 있으면 비밀번호를 바꾼 사람이 여기서 로그인만 하고
  // 끝내게 되고, 수집기는 옛 비밀번호로 계속 시도한다 — 그게 계정을 잠근다.
  const [remember, setRemember] = useState(true);

  function apply(result: Result): void {
    if (result.status === "done") {
      setStage("done");
      setPassword("");
      setWarning(result.warning ?? "");
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
      apply(await post("/api/login/start", { username, password, remember }));
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
        {warning !== "" && (
          <div style={{
            marginTop: 10, background: COLOR.warnBg, color: COLOR.warn,
            border: `1px solid ${COLOR.warn}33`, borderRadius: 8, padding: "10px 12px",
            fontSize: 13, lineHeight: 1.65,
          }}>
            {warning}
            {" "}
            <a href="/settings/account" style={{ color: COLOR.warn, fontWeight: 600 }}>
              계정 설정으로 →
            </a>
          </div>
        )}
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
          <div style={{ marginBottom: 14 }}>
            <label htmlFor="p" style={labelStyle}>비밀번호</label>
            <input
              id="p" type="password" autoComplete="current-password" required
              value={password} onChange={(e) => setPassword(e.target.value)}
              style={inputStyle} disabled={busy}
            />
          </div>
          {/*
            자동 로그인용으로 저장할지. 로그인이 **성공한 뒤에만** 암호화해 저장한다
            (틀린 비밀번호는 저장되지 않는다).

            기본값이 켜져 있는 이유: 비밀번호 회전 때 사람이 여기서 로그인만 하고 끝내면,
            수집기는 저장된 옛 비밀번호로 계속 시도해 공용 계정을 잠근다. 켜 두는 쪽이
            안전하다.
          */}
          <label style={{
            display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 18,
            fontSize: 12.5, color: COLOR.body, lineHeight: 1.6, cursor: "pointer",
          }}>
            <input
              type="checkbox" checked={remember} disabled={busy}
              onChange={(e) => setRemember(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>
              이 계정을 자동 로그인에 쓰기 (암호화해 저장)
              <span style={{ display: "block", color: COLOR.faint, fontSize: 11.5 }}>
                {hasStored
                  ? "저장된 비밀번호를 이 값으로 바꿉니다. 끄면 이번 로그인에만 쓰입니다."
                  : "끄면 이번 로그인에만 쓰이고, 세션이 만료되면 또 로그인해야 합니다."}
              </span>
            </span>
          </label>
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
