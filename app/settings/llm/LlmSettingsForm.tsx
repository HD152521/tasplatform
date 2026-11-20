"use client";

import { useState } from "react";
import type { LlmConfigMeta, LlmConnectionSummary } from "../../../lib/llmConfig.ts";
import { COLOR, Card, MONO_STACK, Notice, RADIUS, controlStyle, formatStamp } from "../../ui.tsx";

const AUTH_KINDS = [
  { value: "keycloak", label: "Keycloak · 호출마다 토큰 발급(비밀번호)" },
  { value: "client_credentials", label: "Keycloak · client_credentials(클라이언트 시크릿)" },
  { value: "bearer", label: "Bearer · 고정 토큰(API 키)" },
  { value: "none", label: "인증 없음" },
] as const;

interface Props {
  /** 지금 **활성**인 설정의 메타. 연결이 하나도 없으면 환경변수 폴백이거나 null 이다. */
  initialConfig: LlmConfigMeta | null;
  initialConnections: readonly LlmConnectionSummary[];
  keyPresent: boolean;
}

type Tone = "ok" | "error" | "warn";

/**
 * 연결 목록 + 선택한 연결의 편집기.
 *
 * 편집기를 `key={선택한 id}` 로 다시 마운트한다. 입력칸 상태를 useState 초기값으로
 * 잡고 있어서, 다른 연결을 골랐을 때 그 값들을 **전부** 갈아 끼워야 하기 때문이다.
 * 하나라도 빠뜨리면 A 연결의 토큰 URL 이 B 연결에 저장된다 — 조용히 틀리는 종류의
 * 버그라 애초에 생기지 않게 둔다.
 */
export function LlmSettingsForm({ initialConfig, initialConnections, keyPresent }: Props) {
  const [connections, setConnections] = useState<readonly LlmConnectionSummary[]>(initialConnections);
  // null = "새 연결". 처음에는 활성 연결을 고른다.
  const [selectedId, setSelectedId] = useState<string | null>(
    initialConnections.find((c) => c.active)?.llmId ?? initialConnections[0]?.llmId ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: Tone; text: string } | null>(null);

  const selected = connections.find((c) => c.llmId === selectedId) ?? null;
  const envFallback = connections.length === 0 && initialConfig?.source === "env";

  async function call(
    url: string,
    init: RequestInit,
    okText: string,
  ): Promise<{ ok: boolean; llmId?: string }> {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(url, init);
      const data = (await res.json()) as {
        ok?: boolean;
        message?: string;
        llmId?: string;
        connections?: LlmConnectionSummary[];
      };
      if (data.connections !== undefined) setConnections(data.connections);
      if (data.ok === true) {
        setMessage({ tone: "ok", text: okText });
        return { ok: true, llmId: data.llmId };
      }
      setMessage({ tone: "error", text: data.message ?? "실패했습니다." });
      return { ok: false };
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
      return { ok: false };
    } finally {
      setBusy(false);
    }
  }

  const activate = (llmId: string): Promise<unknown> =>
    call(
      "/api/settings/llm",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "activate", llmId }),
      },
      "활성 연결을 바꿨습니다. 다음 요약·번역부터 이 연결을 씁니다.",
    );

  async function remove(conn: LlmConnectionSummary): Promise<void> {
    if (!window.confirm(`「${conn.name || conn.llmId}」 연결을 지울까요? 저장된 비밀번호도 함께 사라집니다.`)) {
      return;
    }
    const result = await call(
      `/api/settings/llm?llmId=${encodeURIComponent(conn.llmId)}`,
      { method: "DELETE" },
      "연결을 지웠습니다.",
    );
    if (result.ok && selectedId === conn.llmId) setSelectedId(null);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 660 }}>
      {!keyPresent && (
        <Notice tone="error">
          SR_SECRET_KEY 가 설정되지 않아 비밀번호를 암호화해 저장할 수 없습니다. 서버 환경변수에
          32바이트 키를 넣은 뒤 다시 시도하세요.
        </Notice>
      )}
      {envFallback && (
        <Notice tone="ok">
          지금은 환경변수(LLM_*)에서 읽고 있습니다. 아래에서 연결을 하나 저장하면 그쪽이 우선합니다.
        </Notice>
      )}
      {message !== null && <Notice tone={message.tone}>{message.text}</Notice>}

      {/* ── 연결 목록 ─────────────────────────────────── */}
      {connections.length > 0 && (
        <Card style={{ padding: "14px 16px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>등록된 연결</div>
          <p style={{ margin: "0 0 12px", fontSize: 12, color: COLOR.muted, lineHeight: 1.7 }}>
            요약·번역·보고서는 <strong>활성</strong>으로 표시된 연결만 씁니다. 나머지는 저장만 돼
            있습니다 — 모델을 바꿔 보다가 되돌릴 수 있게 하기 위한 것입니다.
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {connections.map((conn) => {
              const isSelected = conn.llmId === selectedId;
              return (
                <div
                  key={conn.llmId}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "10px 12px", borderRadius: RADIUS.control,
                    border: `1px solid ${isSelected ? COLOR.accent : COLOR.line}`,
                    background: conn.active ? COLOR.okBg : COLOR.surface,
                  }}
                >
                  <input
                    type="radio"
                    name="active-llm"
                    checked={conn.active}
                    onChange={() => void activate(conn.llmId)}
                    disabled={busy}
                    title="이 연결을 활성으로"
                    style={{ cursor: busy ? "default" : "pointer", flexShrink: 0 }}
                  />
                  <button
                    type="button"
                    onClick={() => setSelectedId(conn.llmId)}
                    style={{
                      flex: 1, minWidth: 0, textAlign: "left", background: "transparent",
                      border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit",
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {conn.name === "" ? "(이름 없음)" : conn.name}
                      {conn.active && (
                        <span style={{ color: COLOR.ok, fontSize: 11, marginLeft: 7, fontWeight: 700 }}>
                          활성
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11.5, color: COLOR.muted, fontFamily: MONO_STACK, marginTop: 2 }}>
                      {conn.modelId || "모델 미지정"}
                    </div>
                    <div style={{ fontSize: 11, color: COLOR.faint, marginTop: 2 }}>
                      {conn.updatedAt === "" ? "" : `수정 ${formatStamp(Date.parse(conn.updatedAt))} · `}
                      {conn.hasSecret ? "비밀번호 저장됨" : "비밀번호 없음"}
                    </div>
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void remove(conn)}
                    style={{ ...controlStyle, padding: "5px 9px", fontSize: 12, color: COLOR.waitUs, flexShrink: 0 }}
                  >
                    삭제
                  </button>
                </div>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => setSelectedId(null)}
            style={{ ...controlStyle, marginTop: 12, fontSize: 12.5 }}
          >
            + 새 연결 추가
          </button>
        </Card>
      )}

      {/* ── 편집기 ────────────────────────────────────── */}
      <ConnectionEditor
        key={selectedId ?? "new"}
        llmId={selectedId}
        conn={selected}
        /* 연결이 하나도 없으면 환경변수 값으로 칸을 채워 둔다 — 그대로 저장하면
           .env 설정이 DB 로 옮겨진다(처음 쓰는 사람이 다시 타이핑하지 않게). */
        seedFromEnv={connections.length === 0 ? initialConfig : null}
        keyPresent={keyPresent}
        busy={busy}
        onSaved={(saved, list) => {
          setConnections(list);
          setSelectedId(saved);
          setMessage({ tone: "ok", text: "저장했습니다." });
        }}
        onMessage={setMessage}
      />
    </div>
  );
}

function ConnectionEditor({
  llmId, conn, seedFromEnv, keyPresent, busy, onSaved, onMessage,
}: {
  llmId: string | null;
  conn: LlmConnectionSummary | null;
  seedFromEnv: LlmConfigMeta | null;
  keyPresent: boolean;
  busy: boolean;
  onSaved: (llmId: string, connections: LlmConnectionSummary[]) => void;
  onMessage: (m: { tone: Tone; text: string } | null) => void;
}) {
  const c = conn ?? seedFromEnv;
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
  const [localBusy, setLocalBusy] = useState(false);

  const isNew = llmId === null;
  // 환경변수 폴백 값을 담아 둔 경우에도 "저장된 비밀번호" 는 없다 — DB 행이 없다.
  const hasStoredSecret = conn?.hasSecret === true;
  // 인증 방식을 바꾸면 서버가 새 시크릿을 강제한다(옛 grant 시크릿 재사용 방지).
  const authKindChanged = conn != null && conn.authKind !== authKind;
  const working = busy || localBusy;

  function payload(): Record<string, unknown> {
    return {
      ...(isNew ? { new: true } : { llmId }),
      name, modelId, baseUrl, authKind, tokenUrl, clientId, authUsername, secret,
      chatPath, maxTokens: Number(maxTokens), temperature: Number(temperature), systemPrompt,
    };
  }

  async function save(): Promise<void> {
    setLocalBusy(true);
    onMessage(null);
    try {
      const res = await fetch("/api/settings/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        message?: string;
        llmId?: string;
        connections?: LlmConnectionSummary[];
      };
      if (data.ok === true && data.llmId !== undefined) {
        setSecret("");
        onSaved(data.llmId, data.connections ?? []);
      } else {
        onMessage({ tone: "error", text: data.message ?? "저장에 실패했습니다." });
      }
    } catch (error) {
      onMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setLocalBusy(false);
    }
  }

  async function test(): Promise<void> {
    setLocalBusy(true);
    onMessage(null);
    try {
      const res = await fetch("/api/settings/llm/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      });
      const data = (await res.json()) as { ok?: boolean; detail?: string; message?: string };
      if (data.ok === true) {
        onMessage({ tone: "ok", text: `연결 성공 · 응답: ${data.detail ?? ""}` });
      } else {
        onMessage({ tone: "error", text: `연결 실패: ${data.detail ?? data.message ?? "알 수 없는 오류"}` });
      }
    } catch (error) {
      onMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setLocalBusy(false);
    }
  }

  const isKeycloak = authKind === "keycloak";
  const isClientCredentials = authKind === "client_credentials";
  const needsToken = isKeycloak || isClientCredentials;
  const needsSecret = authKind !== "none";
  const secretLabel = isKeycloak
    ? "인증 비밀번호"
    : isClientCredentials
      ? "client_secret"
      : "토큰(API 키)";

  return (
    <Card style={{ padding: "16px 18px" }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 14 }}>
        {isNew ? "새 연결" : `연결 수정`}
        {!isNew && (
          <span style={{ fontFamily: MONO_STACK, fontSize: 11, color: COLOR.faint, marginLeft: 8 }}>
            {llmId}
          </span>
        )}
      </div>

      <Field label="연결 이름" hint="목록에서 구분하는 이름입니다. 모델 이름을 넣어 두면 알아보기 쉽습니다.">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="사내 Gemma (31b)" style={inputStyle} />
      </Field>

      <Field label="모델 ID">
        <input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="google/gemma-4-31b-it" style={inputStyle} />
      </Field>

      {/*
        http 도 받는다 — 사내 LLM 이 http 로만 열려 있는 경우가 있다. 그때 무엇이
        평문으로 지나가는지는 lib/llmConfig.ts 의 assertHttpUrl 주석에 적어 두었다.
      */}
      <Field label="API 기본 주소" hint="OpenAI 호환 엔드포인트. http · https 모두 가능">
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://pais.ds.lab/api/v1/compatibility/openai" style={inputStyle} />
      </Field>

      <Field label="인증 방식">
        <select value={authKind} onChange={(e) => setAuthKind(e.target.value)} style={inputStyle}>
          {AUTH_KINDS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
        </select>
      </Field>

      {needsToken && (
        <>
          <Field label="토큰 발급 URL" hint="Keycloak OpenID 토큰 엔드포인트. https 만 허용">
            <input value={tokenUrl} onChange={(e) => setTokenUrl(e.target.value)} placeholder="https://pai-keycloak.ds.lab/realms/pais/protocol/openid-connect/token" style={inputStyle} />
          </Field>
          <Field label="Client ID">
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="pais-client" style={inputStyle} />
          </Field>
          {isKeycloak && (
            <Field label="인증 사용자 이름">
              <input value={authUsername} onChange={(e) => setAuthUsername(e.target.value)} placeholder="pais-admin" style={inputStyle} />
            </Field>
          )}
        </>
      )}

      {needsSecret && (
        <Field
          label={secretLabel}
          hint={
            hasStoredSecret && authKindChanged
              ? "인증 방식이 바뀌어 시크릿 재입력이 필요합니다."
              : hasStoredSecret
                ? "저장됨 · 변경할 때만 입력. 화면에는 다시 표시되지 않습니다."
                : "비워두면 저장되지 않습니다."
          }
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
          disabled={working}
          style={{ ...controlStyle, padding: "9px 18px", fontWeight: 600, cursor: working ? "default" : "pointer" }}
        >
          {working ? "확인 중…" : "연결 테스트"}
        </button>
        <button
          type="button"
          onClick={() => { void save(); }}
          disabled={working || !keyPresent}
          style={{
            ...controlStyle, padding: "9px 18px", fontWeight: 600, color: "#ffffff",
            background: working || !keyPresent ? COLOR.muted : COLOR.accent,
            borderColor: working || !keyPresent ? COLOR.muted : COLOR.accent,
            cursor: working || !keyPresent ? "default" : "pointer",
          }}
        >
          {working ? "저장 중…" : isNew ? "연결 추가" : "저장"}
        </button>
      </div>
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
