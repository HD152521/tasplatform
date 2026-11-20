"use client";

import { useState } from "react";
import { COLOR, Card, Notice, RADIUS, controlStyle, formatStamp } from "../../ui.tsx";
import type { PortalCredentialsMeta } from "../../../lib/portalCredentials.ts";
import type { LoginGuardState } from "../../../lib/loginGuard.ts";

interface Props {
  readonly initialCredentials: PortalCredentialsMeta;
  readonly initialGuard: LoginGuardState;
  readonly failLimit: number;
  readonly keyPresent: boolean;
  /** 이 서버가 브라우저 로그인을 못 하는 환경인가(TAS 컨테이너). 저장 후 안내가 달라진다. */
  readonly browserless: boolean;
}

interface Payload {
  readonly ok?: boolean;
  readonly message?: string;
  readonly credentials?: PortalCredentialsMeta;
  readonly guard?: LoginGuardState;
}

/** 마지막 시도 결과를 사람 말로. */
const RESULT_TEXT: Record<string, string> = {
  ok: "성공",
  otp: "OTP 요구 (비밀번호는 통과)",
  rejected: "아이디/비밀번호 거절",
  locked: "계정 잠김",
  expired: "비밀번호 만료",
  failed: "실패(망·화면 등)",
};

export function AccountForm({
  initialCredentials, initialGuard, failLimit, keyPresent, browserless,
}: Props) {
  const [credentials, setCredentials] = useState(initialCredentials);
  const [guard, setGuard] = useState(initialGuard);
  const [username, setUsername] = useState(initialCredentials.username);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "warn"; text: string } | null>(null);

  function apply(data: Payload): void {
    if (data.credentials !== undefined) {
      setCredentials(data.credentials);
      setUsername(data.credentials.username);
    }
    if (data.guard !== undefined) setGuard(data.guard);
  }

  async function call(url: string, init: RequestInit, okText: string): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(url, init);
      const data = (await res.json()) as Payload;
      if (data.ok === true) {
        apply(data);
        setPassword("");
        setMessage({ tone: "ok", text: okText });
      } else {
        setMessage({ tone: "error", text: data.message ?? "실패했습니다." });
      }
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  const save = (): Promise<void> =>
    call(
      "/api/settings/account",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      },
      browserless
        ? "저장했습니다. 수집기가 다음 회차(최대 15분)에 이 계정으로 로그인하고, 결과가 아래에 표시됩니다."
        : "저장했습니다. 자동 로그인이 다음 시도에서 이 계정을 씁니다.",
    );

  const unblock = (): Promise<void> =>
    call(
      "/api/settings/account/unblock",
      { method: "POST" },
      "멈춤을 풀었습니다. 저장된 비밀번호로 한 번만 더 시도하고, 또 실패하면 즉시 다시 멈춥니다.",
    );

  const remove = (): Promise<void> =>
    call(
      "/api/settings/account?actor=",
      { method: "DELETE" },
      "저장된 계정을 지웠습니다. 이제 .env(SR_USERNAME/SR_PASSWORD)를 씁니다.",
    );

  const dirtyUsername = username.trim() !== credentials.username;
  const canSave = keyPresent && !busy && username.trim() !== "" && (password !== "" || dirtyUsername);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 640 }}>
      {!keyPresent && (
        <Notice tone="error">
          SR_SECRET_KEY 가 설정되지 않아 비밀번호를 암호화해 저장할 수 없습니다. 평문으로는
          저장하지 않습니다. 서버 환경변수에 32바이트 키를 넣은 뒤 다시 시도하세요.
        </Notice>
      )}

      <GuardPanel guard={guard} failLimit={failLimit} busy={busy} onUnblock={() => { void unblock(); }} />

      <Card style={{ padding: "16px 18px" }}>
        {message !== null && <Notice tone={message.tone}>{message.text}</Notice>}

        <div style={{ fontSize: 12.5, color: COLOR.muted, marginBottom: 14, lineHeight: 1.7 }}>
          {credentials.source === "db" ? (
            <>
              지금은 <strong>이 화면에 저장된 값</strong>을 씁니다
              {credentials.updatedAt !== "" && <> · 마지막 변경 {formatStamp(Date.parse(credentials.updatedAt))}</>}
              {credentials.updatedBy !== "" && <> ({credentials.updatedBy})</>}
            </>
          ) : credentials.source === "env" ? (
            <>
              지금은 <strong>.env 의 SR_USERNAME / SR_PASSWORD</strong> 를 씁니다. 아래에서 저장하면
              이 값이 우선 적용되고, 다음부터는 파일을 고치지 않아도 됩니다.
            </>
          ) : (
            <>저장된 계정이 없습니다. 세션이 만료되면 사람이 매번 로그인해야 합니다.</>
          )}
        </div>

        <Field label="아이디">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="you@example.com"
            autoComplete="username"
            style={inputStyle}
          />
        </Field>

        <Field
          label="비밀번호"
          hint={
            credentials.hasPassword
              ? "저장됨 · 바꿀 때만 입력하세요. 화면에는 다시 표시되지 않습니다."
              : "자동 로그인에 쓸 비밀번호입니다. 암호화해 저장합니다."
          }
        >
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={credentials.hasPassword ? "••••••••" : ""}
            autoComplete="new-password"
            style={inputStyle}
          />
        </Field>

        <div style={{ display: "flex", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => { void save(); }}
            disabled={!canSave}
            style={{
              ...controlStyle, padding: "9px 18px", fontWeight: 600, color: "#ffffff",
              background: canSave ? COLOR.accent : COLOR.muted,
              borderColor: canSave ? COLOR.accent : COLOR.muted,
              cursor: canSave ? "pointer" : "default",
            }}
          >
            {busy ? "저장 중…" : "저장"}
          </button>
          {credentials.source === "db" && (
            <button
              type="button"
              onClick={() => { void remove(); }}
              disabled={busy}
              style={{ ...controlStyle, padding: "9px 18px", color: COLOR.waitUs }}
            >
              저장된 계정 지우기
            </button>
          )}
        </div>
      </Card>

      <Card style={{ padding: "14px 16px", fontSize: 12.5, color: COLOR.muted, lineHeight: 1.8 }}>
        <strong style={{ color: COLOR.body }}>알아 둘 것</strong>
        <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
          <li>비밀번호는 AES-256-GCM 으로 암호화해 저장합니다. 화면에 다시 표시되지 않습니다.</li>
          <li>
            비밀번호를 바꾸면 기존 세션은 곧 만료됩니다. 수집기가 새 값으로 재로그인하며,
            기기 신뢰가 끊긴 경우에는 OTP 가 필요해 사람이 한 번 로그인해야 합니다.
          </li>
          <li>
            {browserless
              ? "이 서버는 브라우저를 돌리지 못해 저장 즉시 로그인을 시험할 수 없습니다. 수집기가 시도한 결과가 위에 표시됩니다."
              : "저장 후 「Broadcom 로그인」 화면에서 바로 확인할 수 있습니다."}
          </li>
        </ul>
      </Card>
    </div>
  );
}

function GuardPanel({
  guard, failLimit, busy, onUnblock,
}: {
  guard: LoginGuardState;
  failLimit: number;
  busy: boolean;
  onUnblock: () => void;
}) {
  const result = guard.lastResult === "" ? "" : RESULT_TEXT[guard.lastResult] ?? guard.lastResult;

  if (guard.blocked) {
    return (
      <Notice tone="error">
        <strong>자동 로그인을 멈춘 상태입니다 — 계정 잠금 방지</strong>
        <div style={{ marginTop: 6 }}>
          {guard.needsHuman
            ? guard.lastResult === "locked"
              ? "계정이 잠긴 것으로 보입니다. 포털에서 잠금을 푼 뒤 새 비밀번호를 저장하세요."
              : "비밀번호가 만료된 것으로 보입니다. 포털에서 바꾼 뒤 새 비밀번호를 저장하세요."
            : `비밀번호가 ${failLimit}번 거절돼 더 시도하지 않습니다.`}
        </div>
        <div style={{ marginTop: 4 }}>
          <strong>스스로 다시 시도하지 않습니다</strong> — 시간이 지나도 그대로입니다.
          {guard.blockedAt !== "" && <> (멈춘 시각 {formatStamp(Date.parse(guard.blockedAt))})</>}
          {result !== "" && <> · 마지막 결과: {result}</>}
        </div>
        {guard.lastReason !== "" && (
          <div style={{ marginTop: 4, fontSize: 12, opacity: 0.85 }}>사유: {guard.lastReason}</div>
        )}
        <div style={{ marginTop: 10, fontSize: 12 }}>
          <strong>아래에 새 비밀번호를 저장하면 바로 다시 시작합니다.</strong> 비밀번호를 바꾸지
          않은 채 아래 버튼만 누르면 같은 값으로 또 거절당하므로, 그 경우에는 <strong>한 번만</strong>
          {" "}시도하고 즉시 다시 멈춥니다.
        </div>
        <button
          type="button"
          onClick={onUnblock}
          disabled={busy}
          style={{ ...controlStyle, marginTop: 10, padding: "7px 14px", fontSize: 12 }}
        >
          비밀번호 그대로 한 번만 다시 시도
        </button>
      </Notice>
    );
  }

  if (guard.failCount > 0) {
    return (
      <Notice tone="warn">
        <strong>로그인이 연속 {guard.failCount}번 실패했습니다.</strong>
        <div style={{ marginTop: 6 }}>
          {guard.remaining}번 더 실패하면 계정 잠금을 막기 위해 자동 시도를 멈춥니다.
          {result !== "" && <> 마지막 결과: {result}.</>}
        </div>
        {guard.lastReason !== "" && (
          <div style={{ marginTop: 4, fontSize: 12, opacity: 0.85 }}>사유: {guard.lastReason}</div>
        )}
      </Notice>
    );
  }

  if (guard.lastAttemptAt === "") {
    return (
      <Card style={{ padding: "12px 15px", fontSize: 12.5, color: COLOR.muted }}>
        아직 자동 로그인 기록이 없습니다.
      </Card>
    );
  }

  return (
    <Card style={{
      padding: "12px 15px", fontSize: 12.5, color: COLOR.muted,
      borderLeft: `3px solid ${guard.lastResult === "ok" ? COLOR.ok : COLOR.line}`,
      borderRadius: RADIUS.card,
    }}>
      마지막 로그인 시도: {formatStamp(Date.parse(guard.lastAttemptAt))}
      {result !== "" && <> · {result}</>}
    </Card>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "9px 11px", fontSize: 13, lineHeight: 1.6,
  color: COLOR.ink, background: COLOR.surface,
  border: `1px solid ${COLOR.field}`, borderRadius: RADIUS.control,
  fontFamily: "inherit", boxSizing: "border-box", outline: "none", height: 38,
};

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ fontSize: 12.5, fontWeight: 600, display: "block", marginBottom: 6 }}>{label}</label>
      {children}
      {hint !== undefined && (
        <div style={{ fontSize: 11.5, color: COLOR.faint, marginTop: 5 }}>{hint}</div>
      )}
    </div>
  );
}
