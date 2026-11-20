"use client";

import { useState } from "react";
import { COLOR, Card, MONO_STACK, Notice, RADIUS, controlStyle, formatStamp } from "../ui.tsx";

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
      <Card style={{ padding: 20 }}>
        <p style={{ margin: 0, fontSize: 13.5, color: COLOR.body, lineHeight: 1.75 }}>
          속한 팀이 없어 팀 정보를 보여줄 수 없습니다. 아래에서 내 계정은 바꿀 수 있습니다.
        </p>
        <div style={{ marginTop: 20 }}>
          <MyAccount me={me} post={post} busy={busy} />
        </div>
      </Card>
    );
  }

  return (
    <>
      {msg !== null && <Notice tone={msg.tone}>{msg.text}</Notice>}

      {/* ── 팀 ───────────────────────────────────────────── */}
      <Card style={{ padding: 20, marginBottom: 18 }}>
        <h2 style={sectionTitle}>팀 정보</h2>

        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
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
          <div style={{ fontSize: 12, color: COLOR.faint, paddingBottom: 9 }}>
            팀 id <span style={{ fontFamily: MONO_STACK }}>{teamId}</span>
          </div>
        </div>

        {owner && (
          <div style={{ marginTop: 20, paddingTop: 18, borderTop: `1px solid ${COLOR.divider}` }}>
            <label style={labelStyle}>초대 코드</label>
            <p style={{ margin: "0 0 10px", fontSize: 12.5, color: COLOR.muted, lineHeight: 1.7 }}>
              이 코드로 가입하면 이 팀의 팀원이 됩니다. <strong>코드를 지우면 가입이 닫힙니다.</strong>{" "}
              새로 만들면 예전 코드는 즉시 쓸 수 없게 됩니다.
            </p>
            <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap" }}>
              <code style={{
                fontFamily: MONO_STACK, fontSize: 15, letterSpacing: "0.06em",
                background: inviteCode === "" ? COLOR.ground : COLOR.okBg,
                color: inviteCode === "" ? COLOR.faint : COLOR.ok,
                padding: "8px 14px", borderRadius: RADIUS.control, fontWeight: 600,
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
      <Card style={{ padding: 20, marginBottom: 18 }}>
        <h2 style={sectionTitle}>팀원 {members.length}명</h2>

        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", color: COLOR.muted, fontSize: 12 }}>
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
                    <span style={{ color: COLOR.faint, fontSize: 11, marginLeft: 6 }}>(나)</span>
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
                <td style={{ ...td, color: COLOR.faint, fontSize: 12 }}>
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
                      style={{ ...controlStyle, padding: "5px 9px", fontSize: 12 }}
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
                        style={{ ...controlStyle, padding: "5px 9px", fontSize: 12, marginLeft: 6, color: COLOR.waitUs }}
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

        <p style={{ margin: "14px 0 0", fontSize: 12, color: COLOR.faint, lineHeight: 1.7 }}>
          "Jira 연결 안 됨" 인 사람이 담당자인 일정은 Jira 에 <strong>담당자 없이</strong> 올라갑니다
          (본문에 이름은 적힙니다). 각자 아래에서 자기 Jira 계정 id 를 넣으면 됩니다.
        </p>
      </Card>

      {/* ── 내 계정 ──────────────────────────────────────── */}
      <Card style={{ padding: 20 }}>
        <MyAccount me={me} post={post} busy={busy} />
      </Card>
    </>
  );
}

function MyAccount({
  me, post, busy,
}: {
  me: MeView;
  post: (url: string, body: unknown, okText: string) => Promise<unknown>;
  busy: boolean;
}) {
  const [displayName, setDisplayName] = useState(me.displayName);
  const [jira, setJira] = useState(me.jiraAccountId);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");

  return (
    <>
      <h2 style={sectionTitle}>내 계정</h2>

      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 18 }}>
        <div style={{ flex: "1 1 220px", minWidth: 180 }}>
          <label style={labelStyle}>표시 이름</label>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            style={{ ...controlStyle, width: "100%", cursor: "text" }}
          />
        </div>
        <button
          type="button"
          disabled={busy || displayName.trim() === "" || displayName === me.displayName}
          onClick={() => void post("/api/me", { action: "display_name", displayName }, "이름을 바꿨습니다.")}
          style={{ ...controlStyle, opacity: busy ? 0.6 : 1 }}
        >
          저장
        </button>
      </div>

      <div style={{ paddingTop: 18, borderTop: `1px solid ${COLOR.divider}`, marginBottom: 18 }}>
        <label style={labelStyle}>Jira 계정 id (accountId)</label>
        <p style={{ margin: "0 0 10px", fontSize: 12.5, color: COLOR.muted, lineHeight: 1.7 }}>
          캘린더 일정을 Jira 에 올릴 때 <strong>담당자</strong>로 쓰는 값입니다. Jira 에서 내 프로필을
          열면 주소 끝에 붙어 있습니다(<span style={{ fontFamily: MONO_STACK }}>…/jira/people/<b>이 부분</b></span>).
          비워 두면 담당자 없이 올라갑니다.
        </p>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <input
            value={jira}
            onChange={(e) => setJira(e.target.value)}
            placeholder="5d1234abcd…"
            style={{ ...controlStyle, flex: "1 1 260px", cursor: "text", fontFamily: MONO_STACK }}
          />
          <button
            type="button"
            disabled={busy || jira === me.jiraAccountId}
            onClick={() => void post("/api/me", { action: "jira_account", jiraAccountId: jira }, "Jira 계정을 저장했습니다.")}
            style={{ ...controlStyle, opacity: busy ? 0.6 : 1 }}
          >
            저장
          </button>
        </div>
      </div>

      <div style={{ paddingTop: 18, borderTop: `1px solid ${COLOR.divider}` }}>
        <label style={labelStyle}>비밀번호 변경</label>
        <p style={{ margin: "0 0 10px", fontSize: 12.5, color: COLOR.muted, lineHeight: 1.7 }}>
          바꾸면 <strong>모든 기기에서 로그아웃</strong>됩니다(이 브라우저까지). 다시 로그인해야 합니다.
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            placeholder="지금 비밀번호"
            autoComplete="current-password"
            style={{ ...controlStyle, flex: "1 1 180px", cursor: "text" }}
          />
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder="새 비밀번호 (8자 이상)"
            autoComplete="new-password"
            style={{ ...controlStyle, flex: "1 1 180px", cursor: "text" }}
          />
          <button
            type="button"
            disabled={busy || current === "" || next.length < 8}
            onClick={async () => {
              const data = (await post(
                "/api/me",
                { action: "password", currentPassword: current, newPassword: next },
                "비밀번호를 바꿨습니다.",
              )) as { signedOut?: boolean } | null;
              setCurrent("");
              setNext("");
              if (data?.signedOut === true) {
                // 세션이 끊겼으므로 로그인 화면으로 보낸다.
                window.setTimeout(() => {
                  window.location.href = "/signin";
                }, 1500);
              }
            }}
            style={{ ...controlStyle, opacity: busy ? 0.6 : 1 }}
          >
            비밀번호 변경
          </button>
        </div>
      </div>
    </>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  margin: "0 0 16px",
  letterSpacing: "-0.01em",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: COLOR.body,
  marginBottom: 6,
};

const th: React.CSSProperties = { padding: "0 8px 8px 0", fontWeight: 600 };
const td: React.CSSProperties = { padding: "10px 8px 10px 0", verticalAlign: "middle" };
