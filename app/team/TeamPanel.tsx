"use client";

import { useState } from "react";
import { Card, COLOR, controlStyle, formatStamp, MONO_STACK, Notice, RADIUS, SPACE, TEXT, WEIGHT } from "../ui.tsx";

export interface TeamMemberView {
  readonly userId: number;
  readonly loginId: string;
  readonly displayName: string;
  readonly role: "owner" | "member";
  readonly joinedAt: string;
  readonly lastLoginAt: string;
  readonly hasJira: boolean;
}

interface MeView {
  readonly userId: number;
  readonly loginId: string;
  readonly displayName: string;
  readonly role: "owner" | "member";
  readonly jiraAccountId: string;
}

interface Props {
  readonly teamId: string;
  readonly teamName: string;
  readonly initialInviteCode: string;
  readonly members: readonly TeamMemberView[];
  readonly me: MeView;
}

type Tone = "ok" | "error" | "warn";

export function TeamPanel({ teamId, teamName, initialInviteCode, members, me }: Props) {
  const [inviteCode, setInviteCode] = useState(initialInviteCode);
  const [name, setName] = useState(teamName);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null);

  const owner = me.role === "owner";

  async function post(url: string, body: unknown, okText: string): Promise<unknown> {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { ok?: boolean; message?: string };
      if (data.ok === true) {
        setMsg({ tone: "ok", text: data.message ?? okText });
        return data;
      }
      setMsg({ tone: "error", text: data.message ?? "실패했습니다." });
      return null;
    } catch (error) {
      setMsg({ tone: "error", text: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function teamAction(body: Record<string, unknown>, okText: string): Promise<void> {
    const data = (await post("/api/team", body, okText)) as { inviteCode?: string } | null;
    if (data === null) return;
    if (data.inviteCode !== undefined) setInviteCode(data.inviteCode);
    // 팀원 목록은 서버가 그린다. 바꾼 뒤에는 다시 읽어 와야 한다.
    if (body.action === "set_role" || body.action === "remove_member") window.location.reload();
  }

  if (teamId === "") {
    return (
      <Card style={{ padding: SPACE.xl }}>
        <p style={{ margin: 0, fontSize: TEXT.base, color: COLOR.body, lineHeight: 1.75 }}>
          속한 팀이 없어 팀 정보를 보여줄 수 없습니다. 내 이름·비밀번호는{" "}
          <a href="/me" style={{ color: COLOR.accent }}>내 설정</a> 에서 바꿀 수 있습니다.
        </p>
      </Card>
    );
  }

  return (
    <>
      {msg !== null && <Notice tone={msg.tone}>{msg.text}</Notice>}

      {/* ── 팀 ───────────────────────────────────────────── */}
      <Card style={{ padding: SPACE.xl, marginBottom: SPACE.lg }}>
        <h2 style={sectionTitle}>팀 정보</h2>

        <div style={{ display: "flex", gap: SPACE.sm, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 240px", minWidth: 200 }}>
            <label style={labelStyle}>팀 이름</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!owner}
              style={{ ...controlStyle, width: "100%", cursor: owner ? "text" : "default" }}
            />
          </div>
          {owner && (
            <button
              type="button"
              disabled={busy || name.trim() === "" || name === teamName}
              onClick={() => teamAction({ action: "team_name", teamName: name }, "팀 이름을 바꿨습니다.")}
              style={{ ...controlStyle, opacity: busy ? 0.6 : 1 }}
            >
              이름 저장
            </button>
          )}
          <div style={{ fontSize: TEXT.small, color: COLOR.faint, paddingBottom: SPACE.sm }}>
            팀 id <span style={{ fontFamily: MONO_STACK }}>{teamId}</span>
          </div>
        </div>

        {owner && (
          <div style={{ marginTop: SPACE.xl, paddingTop: SPACE.lg, borderTop: `1px solid ${COLOR.divider}` }}>
            <label style={labelStyle}>초대 코드</label>
            <p style={{ margin: `0 0 ${SPACE.sm}px`, fontSize: TEXT.small, color: COLOR.muted, lineHeight: 1.7 }}>
              이 코드로 가입하면 이 팀의 팀원이 됩니다. <strong>코드를 지우면 가입이 닫힙니다.</strong>{" "}
              새로 만들면 예전 코드는 즉시 쓸 수 없게 됩니다.
            </p>
            <div style={{ display: "flex", gap: SPACE.sm, alignItems: "center", flexWrap: "wrap" }}>
              <code style={{
                fontFamily: MONO_STACK, fontSize: TEXT.lead, letterSpacing: "0.06em",
                background: inviteCode === "" ? COLOR.ground : COLOR.okBg,
                color: inviteCode === "" ? COLOR.faint : COLOR.ok,
                padding: `${SPACE.sm}px ${SPACE.md}px`, borderRadius: RADIUS.control, fontWeight: WEIGHT.semibold,
              }}>
                {inviteCode === "" ? "가입 닫힘" : inviteCode}
              </code>
              <button
                type="button"
                disabled={busy}
                onClick={() => teamAction({ action: "invite_new" }, "새 초대 코드를 만들었습니다.")}
                style={{ ...controlStyle, opacity: busy ? 0.6 : 1 }}
              >
                새로 만들기
              </button>
              {inviteCode !== "" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => teamAction({ action: "invite_clear" }, "가입을 닫았습니다.")}
                  style={{ ...controlStyle, color: COLOR.waitUs, opacity: busy ? 0.6 : 1 }}
                >
                  가입 닫기
                </button>
              )}
            </div>
          </div>
        )}
      </Card>

      {/* ── 팀원 ─────────────────────────────────────────── */}
      <Card style={{ padding: SPACE.xl, marginBottom: SPACE.lg }}>
        <h2 style={sectionTitle}>팀원 {members.length}명</h2>

        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: TEXT.base }}>
          <thead>
            <tr style={{ textAlign: "left", color: COLOR.muted, fontSize: TEXT.small }}>
              <th style={th}>이름</th>
              <th style={th}>아이디</th>
              <th style={th}>역할</th>
              <th style={th}>Jira</th>
              <th style={th}>마지막 로그인</th>
              {owner && <th style={th} />}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.userId} style={{ borderTop: `1px solid ${COLOR.divider}` }}>
                <td style={td}>
                  {m.displayName}
                  {m.userId === me.userId && (
                    <span style={{ color: COLOR.faint, fontSize: TEXT.micro, marginLeft: SPACE.xs }}>(나)</span>
                  )}
                </td>
                <td style={{ ...td, fontFamily: MONO_STACK, color: COLOR.muted }}>{m.loginId}</td>
                <td style={td}>{m.role === "owner" ? "관리자" : "팀원"}</td>
                <td style={td}>
                  {m.hasJira ? (
                    <span style={{ color: COLOR.ok }}>연결됨</span>
                  ) : (
                    <span style={{ color: COLOR.warn }}>연결 안 됨</span>
                  )}
                </td>
                <td style={{ ...td, color: COLOR.faint, fontSize: TEXT.small }}>
                  {m.lastLoginAt === "" ? "-" : formatStamp(Date.parse(m.lastLoginAt))}
                </td>
                {owner && (
                  <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        teamAction(
                          { action: "set_role", userId: m.userId, role: m.role === "owner" ? "member" : "owner" },
                          "역할을 바꿨습니다.",
                        )
                      }
                      style={{ ...controlStyle, padding: `${SPACE.xs}px ${SPACE.sm}px`, fontSize: TEXT.small }}
                    >
                      {m.role === "owner" ? "팀원으로" : "관리자로"}
                    </button>
                    {m.userId !== me.userId && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (!window.confirm(`${m.displayName} 님을 이 팀에서 뺄까요? 계정은 남습니다.`)) return;
                          void teamAction({ action: "remove_member", userId: m.userId }, "팀에서 뺐습니다.");
                        }}
                        style={{ ...controlStyle, padding: `${SPACE.xs}px ${SPACE.sm}px`, fontSize: TEXT.small, marginLeft: SPACE.xs, color: COLOR.waitUs }}
                      >
                        내보내기
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>

        <p style={{ margin: `${SPACE.md}px 0 0`, fontSize: TEXT.small, color: COLOR.faint, lineHeight: 1.7 }}>
          "Jira 연결 안 됨" 인 사람이 담당자인 일정은 Jira 에 <strong>담당자 없이</strong> 올라갑니다
          (본문에 이름은 적힙니다). 각자 아래에서 자기 Jira 계정 id 를 넣으면 됩니다.
        </p>
      </Card>

      {/* ── 내 계정 ──────────────────────────────────────── */}
      <Card style={{ padding: SPACE.xl }}>
        <h2 style={sectionTitle}>이 팀의 브로드컴 계정</h2>
        <p style={{ margin: 0, fontSize: TEXT.small, color: COLOR.muted, lineHeight: 1.8 }}>
          수집·SR 쓰기가 쓰는 <strong>포털 공용 계정은 팀에 귀속</strong>됩니다. 팀마다 다른
          계정을 쓰고, 세션·기기신뢰·잠금 방지 상태도 팀별로 따로 갑니다 — 다른 팀의 계정이
          이 팀에 영향을 주지 않습니다.
        </p>
        <div style={{ marginTop: SPACE.md, display: "flex", gap: SPACE.sm, flexWrap: "wrap" }}>
          <a href="/settings/account" style={{ ...controlStyle, textDecoration: "none" }}>
            브로드컴 계정 설정 →
          </a>
          <a href="/me" style={{ ...controlStyle, textDecoration: "none" }}>
            내 설정(이름·비밀번호·Jira) →
          </a>
        </div>
      </Card>
    </>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: TEXT.lead,
  fontWeight: WEIGHT.bold,
  margin: `0 0 ${SPACE.lg}px`,
  letterSpacing: "-0.01em",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: TEXT.small,
  fontWeight: WEIGHT.semibold,
  color: COLOR.body,
  marginBottom: SPACE.xs,
};

const th: React.CSSProperties = { padding: `0 ${SPACE.sm}px ${SPACE.sm}px 0`, fontWeight: WEIGHT.semibold };
const td: React.CSSProperties = { padding: `${SPACE.sm}px ${SPACE.sm}px ${SPACE.sm}px 0`, verticalAlign: "middle" };
