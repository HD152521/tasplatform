"use client";

import { useState } from "react";
import { COLOR, Card, MONO_STACK, Notice, controlStyle } from "../ui.tsx";

interface Props {
  readonly loginId: string;
  readonly displayName: string;
  readonly jiraAccountId: string;
  readonly teamName: string;
  readonly role: "owner" | "member";
}

type Tone = "ok" | "error" | "warn";

/**
 * 내 설정 — **나에게만 해당되는 것.**
 *
 * 팀 설정(`/team`)과 갈라 둔 이유: 전에는 한 화면에 팀 이름·초대 코드·팀원 목록과
 * 내 비밀번호가 함께 있었다. 바꾸는 사람도 다르고(팀은 owner, 내 것은 나) 바꾸는
 * 빈도도 다른데, 같은 화면에 있으면 "내 이름을 고치려다 팀 이름을 고치는" 일이 생긴다.
 *
 * 브로드컴 공용 계정은 **팀 것**이므로 여기 없다(`/settings/account`).
 */
export function MyAccountPanel({ loginId, displayName, jiraAccountId, teamName, role }: Props) {
  const [name, setName] = useState(displayName);
  const [jira, setJira] = useState(jiraAccountId);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null);

  async function post(body: unknown, okText: string): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/me", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { ok?: boolean; message?: string };
      if (data.ok === true) {
        setMsg({ tone: "ok", text: data.message ?? okText });
        return data as Record<string, unknown>;
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

  return (
    <>
      {msg !== null && <Notice tone={msg.tone}>{msg.text}</Notice>}

      {/* ── 누구인가 ──────────────────────────────────── */}
      <Card style={{ padding: 20, marginBottom: 16 }}>
        <h2 style={sectionTitle}>내 정보</h2>

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 18 }}>
          <Readonly label="아이디" value={loginId} mono />
          <Readonly label="소속 팀" value={teamName === "" ? "없음" : teamName} />
          <Readonly label="역할" value={role === "owner" ? "팀 관리자" : "팀원"} />
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 240px", minWidth: 200 }}>
            <label style={labelStyle}>표시 이름</label>
            <p style={hintStyle}>
              일정의 담당자·등록자, 주간 정리의 사람별 섹션에 이 이름으로 나옵니다.
            </p>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ ...controlStyle, width: "100%", cursor: "text" }}
            />
          </div>
          <button
            type="button"
            disabled={busy || name.trim() === "" || name === displayName}
            onClick={() => void post({ action: "display_name", displayName: name }, "이름을 바꿨습니다.")}
            style={{ ...controlStyle, opacity: busy ? 0.6 : 1 }}
          >
            저장
          </button>
        </div>
      </Card>

      {/* ── Jira 연결 ─────────────────────────────────── */}
      <Card style={{ padding: 20, marginBottom: 16 }}>
        <h2 style={sectionTitle}>Jira 계정 연결</h2>
        <p style={hintStyle}>
          이 값이 있어야 일정이 Jira 에 올라갈 때 <strong>담당자로 지정</strong>되고,
          본문의 <code>@내이름</code> 이 <strong>실제 멘션</strong>이 되어 알림이 옵니다.
          비워 두면 담당자 없이 올라가고 이름은 글자로만 들어갑니다.
        </p>
        <p style={{ ...hintStyle, marginTop: 8 }}>
          찾는 곳: Jira 우상단 아바타 → 프로필 → 주소창 끝{" "}
          <span style={{ fontFamily: MONO_STACK }}>…/jira/people/<b>이 부분</b></span>. 또는 Jira 에
          로그인한 브라우저에서 <span style={{ fontFamily: MONO_STACK }}>/rest/api/3/myself</span> 를
          열면 <span style={{ fontFamily: MONO_STACK }}>accountId</span> 로 보입니다. 비밀값이
          아니라 공개 식별자입니다.
        </p>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap", marginTop: 12 }}>
          <input
            value={jira}
            onChange={(e) => setJira(e.target.value)}
            placeholder="5d1234abcd…"
            style={{ ...controlStyle, flex: "1 1 280px", cursor: "text", fontFamily: MONO_STACK }}
          />
          <button
            type="button"
            disabled={busy || jira === jiraAccountId}
            onClick={() => void post({ action: "jira_account", jiraAccountId: jira }, "Jira 계정을 저장했습니다.")}
            style={{ ...controlStyle, opacity: busy ? 0.6 : 1 }}
          >
            저장
          </button>
          {jiraAccountId !== "" && (
            <span style={{ fontSize: 12, color: COLOR.ok, paddingBottom: 9 }}>연결됨</span>
          )}
        </div>
      </Card>

      {/* ── 비밀번호 ──────────────────────────────────── */}
      <Card style={{ padding: 20 }}>
        <h2 style={sectionTitle}>비밀번호 변경</h2>
        <p style={hintStyle}>
          이 도구의 로그인 비밀번호입니다 — 브로드컴 포털 계정과 다릅니다. 바꾸면{" "}
          <strong>모든 기기에서 로그아웃</strong>됩니다(이 브라우저까지).
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
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
                { action: "password", currentPassword: current, newPassword: next },
                "비밀번호를 바꿨습니다.",
              )) as { signedOut?: boolean } | null;
              setCurrent("");
              setNext("");
              if (data?.signedOut === true) {
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
      </Card>
    </>
  );
}

function Readonly({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 11.5, color: COLOR.faint, fontWeight: 600 }}>{label}</div>
      <div style={{
        fontSize: 13.5, marginTop: 3, fontWeight: 500,
        fontFamily: mono === true ? MONO_STACK : "inherit",
      }}>
        {value}
      </div>
    </div>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  margin: "0 0 14px",
  letterSpacing: "-0.01em",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: COLOR.body,
  marginBottom: 4,
};

const hintStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 12.5,
  color: COLOR.muted,
  lineHeight: 1.75,
};
