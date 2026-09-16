"use client";

import { useState } from "react";
import type { LlmConfigMeta } from "../../../lib/llmConfig.ts";
import { COLOR, Card, Notice, RADIUS, controlStyle } from "../../ui.tsx";

const AUTH_KINDS = [
  { value: "keycloak", label: "Keycloak · 호출마다 토큰 발급" },
  { value: "bearer", label: "Bearer · 고정 토큰(API 키)" },
  { value: "none", label: "인증 없음" },
] as const;

interface Props {
  initialConfig: LlmConfigMeta | null;
  keyPresent: boolean;
}

export function LlmSettingsForm({ initialConfig, keyPresent }: Props) {
  const c = initialConfig;
  const [name, setName] = useState(c?.name ?? "");
  const [modelId, setModelId] = useState(c?.modelId ?? "");
  const [baseUrl, setBaseUrl] = useState(c?.baseUrl ?? "");
  const [authKind, setAuthKind] = useState<string>(c?.authKind ?? "keycloak");
  const [tokenUrl, setTokenUrl] = useState(c?.tokenUrl ?? "");
  const [clientId, setClientId] = useState(c?.clientId ?? "");
  const [authUsername, setAuthUsername] = useState(c?.authUsername ?? "");
  const [secret, setSecret] = useState("");
  const [chatPath, setChatPath] = useState(c?.chatPath ?? "/v1/chat/completions");
  const [maxTokens, setMaxTokens] = useState(String(c?.maxTokens ?? 512));
  const [temperature, setTemperature] = useState(String(c?.temperature ?? 0.1));
  const [systemPrompt, setSystemPrompt] = useState(c?.systemPrompt ?? "");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const hasStoredSecret = c?.hasSecret === true;
  const fromEnv = c?.source === "env";

  function payload(): Record<string, unknown> {
    return {
      name, modelId, baseUrl, authKind, tokenUrl, clientId, authUsername, secret,
      chatPath, maxTokens: Number(maxTokens), temperature: Number(temperature), systemPrompt,
    };
  }

  async function save(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      });
      const data = (await res.json()) as { ok?: boolean; message?: string };
      if (data.ok === true) {
        setMessage({ tone: "ok", text: "저장했습니다." });
        setSecret("");
      } else {
        setMessage({ tone: "error", text: data.message ?? "저장에 실패했습니다." });
      }
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function test(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings/llm/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      });
      const data = (await res.json()) as { ok?: boolean; detail?: string; message?: string };
      if (data.ok === true) {
        setMessage({ tone: "ok", text: `연결 성공 · 응답: ${data.detail ?? ""}` });
      } else {
        setMessage({ tone: "error", text: `연결 실패: ${data.detail ?? data.message ?? "알 수 없는 오류"}` });
      }
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  const isKeycloak = authKind === "keycloak";
  const needsSecret = authKind !== "none";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 640 }}>
      {!keyPresent && (
        <Notice tone="error">
          SR_SECRET_KEY 가 설정되지 않아 비밀번호를 암호화해 저장할 수 없습니다. 서버 환경변수에
          32바이트 키를 넣은 뒤 다시 시도하세요.
        </Notice>
      )}
      {fromEnv && (
        <Notice tone="ok">
          현재 설정은 환경변수(LLM_*)에서 읽고 있습니다. 아래에서 저장하면 DB 설정이 우선 적용됩니다.
        </Notice>
      )}

      <Card style={{ padding: "16px 18px" }}>
        {message !== null && (
          <Notice tone={message.tone === "ok" ? "ok" : "error"}>{message.text}</Notice>
        )}

        <Field label="연결 이름">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="기본 LLM (Gemma-4-31b)" style={inputStyle} />
        </Field>

        <Field label="모델 ID">
          <input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="google/gemma-4-31b-it" style={inputStyle} />
        </Field>

        <Field label="API 기본 주소" hint="OpenAI 호환 엔드포인트. https 만 허용">
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://pais.ds.lab/api/v1/compatibility/openai" style={inputStyle} />
        </Field>

        <Field label="인증 방식">
          <select value={authKind} onChange={(e) => setAuthKind(e.target.value)} style={inputStyle}>
            {AUTH_KINDS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        </Field>

        {isKeycloak && (
          <>
            <Field label="토큰 발급 URL" hint="Keycloak OpenID 토큰 엔드포인트. https 만 허용">
              <input value={tokenUrl} onChange={(e) => setTokenUrl(e.target.value)} placeholder="https://pai-keycloak.ds.lab/realms/pais/protocol/openid-connect/token" style={inputStyle} />
            </Field>
            <Field label="Client ID">
              <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="pais-client" style={inputStyle} />
            </Field>
            <Field label="인증 사용자 이름">
              <input value={authUsername} onChange={(e) => setAuthUsername(e.target.value)} placeholder="pais-admin" style={inputStyle} />
            </Field>
          </>
        )}

        {needsSecret && (
          <Field
            label={isKeycloak ? "인증 비밀번호" : "토큰(API 키)"}
            hint={hasStoredSecret ? "저장됨 · 변경할 때만 입력. 화면에는 다시 표시되지 않습니다." : "비워두면 저장되지 않습니다."}
          >
            <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={hasStoredSecret ? "••••••••" : ""} style={inputStyle} />
          </Field>
        )}

        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          style={{ ...controlStyle, padding: "6px 12px", fontSize: 12, marginBottom: showAdvanced ? 14 : 0 }}
        >
          {showAdvanced ? "고급 설정 숨기기 ▲" : "고급 설정 ▼"}
        </button>

        {showAdvanced && (
          <>
            <Field label="Chat API 경로" hint="기본 /v1/chat/completions">
              <input value={chatPath} onChange={(e) => setChatPath(e.target.value)} placeholder="/v1/chat/completions" style={inputStyle} />
            </Field>
            <Field label="최대 출력 토큰" hint="리포트처럼 긴 출력이 필요한 호출은 코드에서 이 값을 넘어설 수 있습니다.">
              <input type="number" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} style={inputStyle} />
            </Field>
            <Field label="Temperature" hint="형식을 지키게 하려면 낮게(0.1) 두는 편이 안정적입니다.">
              <input type="number" step="0.1" value={temperature} onChange={(e) => setTemperature(e.target.value)} style={inputStyle} />
            </Field>
            <Field label="시스템 지침" hint="모든 호출의 system 앞에 덧붙입니다. 코드 수정 없이 전역 지침을 조정할 때 씁니다.">
              <textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={4} style={{ ...inputStyle, height: "auto", resize: "vertical", lineHeight: 1.6 }} />
            </Field>
          </>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
          <button
            type="button"
            onClick={() => { void test(); }}
            disabled={busy}
            style={{ ...controlStyle, padding: "9px 18px", fontWeight: 600, cursor: busy ? "default" : "pointer" }}
          >
            {busy ? "확인 중…" : "연결 테스트"}
          </button>
          <button
            type="button"
            onClick={() => { void save(); }}
            disabled={busy || !keyPresent}
            style={{
              ...controlStyle, padding: "9px 18px", fontWeight: 600, color: "#ffffff",
              background: busy || !keyPresent ? COLOR.muted : COLOR.accent,
              borderColor: busy || !keyPresent ? COLOR.muted : COLOR.accent,
              cursor: busy || !keyPresent ? "default" : "pointer",
            }}
          >
            {busy ? "저장 중…" : "저장"}
          </button>
        </div>
      </Card>
    </div>
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
