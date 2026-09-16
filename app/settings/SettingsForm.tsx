"use client";

import { useState } from "react";
import type { TeamRow } from "../../lib/db.ts";
import type { TeamIntegrationMeta } from "../../lib/teamIntegration.ts";
import { COLOR, Card, Notice, RADIUS, controlStyle } from "../ui.tsx";

/** 지금은 Jira 하나뿐이지만, team_integrations 는 kind 로 구분되므로 목록만 늘리면 다른 연동도 같은 틀을 쓴다. */
const KINDS = [{ value: "jira", label: "Jira" }] as const;

interface Props {
  initialTeamId: string;
  teams: TeamRow[];
  initialIntegrations: TeamIntegrationMeta[];
}

export function SettingsForm({ initialTeamId, teams, initialIntegrations }: Props) {
  const [teamId, setTeamId] = useState(initialTeamId);
  const [integrations, setIntegrations] = useState<TeamIntegrationMeta[]>(initialIntegrations);
  const [kind, setKind] = useState<string>(KINDS[0].value);
  const [baseUrl, setBaseUrl] = useState("");
  const [project, setProject] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function refresh(nextTeamId: string): Promise<void> {
    try {
      const response = await fetch(`/api/settings?team=${encodeURIComponent(nextTeamId)}`);
      const data = (await response.json()) as {
        ok?: boolean; integrations?: TeamIntegrationMeta[]; message?: string;
      };
      if (data.ok === true && data.integrations !== undefined) {
        setIntegrations(data.integrations);
      } else {
        setMessage({ tone: "error", text: data.message ?? "목록을 불러오지 못했습니다." });
      }
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }

  async function onTeamChange(next: string): Promise<void> {
    setTeamId(next);
    setMessage(null);
    await refresh(next);
  }

  async function save(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ team: teamId, kind, baseUrl, project, secret }),
      });
      const data = (await response.json()) as { ok?: boolean; message?: string };
      if (data.ok === true) {
        setMessage({ tone: "ok", text: "저장했습니다." });
        setSecret("");
        await refresh(teamId);
      } else {
        setMessage({ tone: "error", text: data.message ?? "저장에 실패했습니다." });
      }
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function remove(targetKind: string): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/settings?team=${encodeURIComponent(teamId)}&kind=${encodeURIComponent(targetKind)}`,
        { method: "DELETE" },
      );
      const data = (await response.json()) as { ok?: boolean; message?: string };
      if (data.ok === true) {
        await refresh(teamId);
      } else {
        setMessage({ tone: "error", text: data.message ?? "삭제에 실패했습니다." });
      }
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 640 }}>
      <Card style={{ padding: "16px 18px" }}>
        <Field label="팀">
          <select
            value={teamId}
            onChange={(e) => { void onTeamChange(e.target.value); }}
            style={inputStyle}
          >
            {teams.map((t) => (
              <option key={t.team_id} value={t.team_id}>{t.team_name || t.team_id}</option>
            ))}
          </select>
        </Field>

        {message !== null && (
          <Notice tone={message.tone === "ok" ? "ok" : "error"}>{message.text}</Notice>
        )}

        <Field label="연동 종류">
          <select value={kind} onChange={(e) => setKind(e.target.value)} style={inputStyle}>
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </Field>

        <Field label="Base URL" hint="예: https://your-domain.atlassian.net (https 만 허용)">
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://your-domain.atlassian.net"
            style={inputStyle}
          />
        </Field>

        <Field label="Project" hint="Jira 프로젝트 키">
          <input value={project} onChange={(e) => setProject(e.target.value)} placeholder="ABC" style={inputStyle} />
        </Field>

        <Field label="Token" hint="비워두면 기존 토큰을 그대로 유지합니다. 화면에는 다시 표시되지 않습니다.">
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="••••••••"
            style={inputStyle}
          />
        </Field>

        <button
          type="button"
          onClick={() => { void save(); }}
          disabled={busy}
          style={{
            ...controlStyle, padding: "9px 18px", fontWeight: 600, color: "#ffffff",
            background: busy ? COLOR.muted : COLOR.accent,
            borderColor: busy ? COLOR.muted : COLOR.accent,
            cursor: busy ? "default" : "pointer",
          }}
        >
          {busy ? "저장 중…" : "저장"}
        </button>
      </Card>

      <Card style={{ padding: "16px 18px" }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>등록된 연동</div>
        {integrations.length === 0 ? (
          <div style={{ fontSize: 12.5, color: COLOR.faint }}>등록된 연동이 없습니다.</div>
        ) : (
          integrations.map((it) => (
            <div
              key={it.kind}
              style={{
                display: "flex", alignItems: "center", gap: 10, padding: "10px 0",
                borderBottom: `1px solid ${COLOR.divider}`, fontSize: 12.5,
              }}
            >
              <span style={{ fontWeight: 600, width: 60 }}>{it.kind}</span>
              <span style={{
                color: COLOR.faint, flex: 1, minWidth: 0,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {`${it.baseUrl} · ${it.project}`}
              </span>
              <span style={{
                fontSize: 11, padding: "2px 8px", borderRadius: RADIUS.badge,
                color: it.hasSecret ? COLOR.ok : COLOR.warn,
                background: it.hasSecret ? COLOR.okBg : COLOR.warnBg,
              }}>
                {it.hasSecret ? "토큰 설정됨" : "토큰 미설정"}
              </span>
              <button
                type="button"
                onClick={() => { void remove(it.kind); }}
                disabled={busy}
                style={{ ...controlStyle, padding: "4px 10px", fontSize: 11.5 }}
              >
                삭제
              </button>
            </div>
          ))
        )}
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
