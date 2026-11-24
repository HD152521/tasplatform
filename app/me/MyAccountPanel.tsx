"use client";

import { useState } from "react";
import { Card, COLOR, controlStyle, MONO_STACK, Notice, SPACE, TEXT, WEIGHT } from "../ui.tsx";
import type { NotionAccountMeta } from "../../lib/notionAccount.ts";

interface Props {
  readonly loginId: string;
  readonly displayName: string;
  readonly jiraAccountId: string;
  /** 내 노션 연결 상태. **토큰은 담기지 않는다** — 담으면 그게 유출 경로다. */
  readonly notion: NotionAccountMeta;
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
export function MyAccountPanel({
  loginId, displayName, jiraAccountId, notion, teamName, role,
}: Props) {
  const [name, setName] = useState(displayName);
  const [jira, setJira] = useState(jiraAccountId);
  /*
   * 토큰 칸은 **늘 빈 칸으로 시작한다.** 저장된 값을 되돌려주지 않으므로 채울 수도 없다.
   * 비운 채로 저장하면 토큰은 그대로 두고 부모 페이지만 바뀐다(lib/notionAccount.ts) —
   * 페이지만 옮기려는 사람이 토큰을 다시 받아 오지 않아도 되게.
   */
  const [notionToken, setNotionToken] = useState("");
  const [notionPage, setNotionPage] = useState(notion.parentPageId);
  const [notionState, setNotionState] = useState(notion);
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
      <Card style={{ padding: SPACE.xl, marginBottom: SPACE.lg }}>
        <h2 style={sectionTitle}>내 정보</h2>

        <div style={{ display: "flex", gap: SPACE.lg, flexWrap: "wrap", marginBottom: SPACE.lg }}>
          <Readonly label="아이디" value={loginId} mono />
          <Readonly label="소속 팀" value={teamName === "" ? "없음" : teamName} />
          <Readonly label="역할" value={role === "owner" ? "팀 관리자" : "팀원"} />
        </div>

        <div style={{ display: "flex", gap: SPACE.sm, alignItems: "flex-end", flexWrap: "wrap" }}>
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
      <Card style={{ padding: SPACE.xl, marginBottom: SPACE.lg }}>
        <h2 style={sectionTitle}>Jira 계정 연결</h2>
        <p style={hintStyle}>
          이 값이 있어야 일정이 Jira 에 올라갈 때 <strong>담당자로 지정</strong>되고,
          본문의 <code>@내이름</code> 이 <strong>실제 멘션</strong>이 되어 알림이 옵니다.
          비워 두면 담당자 없이 올라가고 이름은 글자로만 들어갑니다.
        </p>
        <p style={{ ...hintStyle, marginTop: SPACE.sm }}>
          찾는 곳: Jira 우상단 아바타 → 프로필 → 주소창 끝{" "}
          <span style={{ fontFamily: MONO_STACK }}>…/jira/people/<b>이 부분</b></span>. 또는 Jira 에
          로그인한 브라우저에서 <span style={{ fontFamily: MONO_STACK }}>/rest/api/3/myself</span> 를
          열면 <span style={{ fontFamily: MONO_STACK }}>accountId</span> 로 보입니다. 비밀값이
          아니라 공개 식별자입니다.
        </p>
        <div style={{ display: "flex", gap: SPACE.sm, alignItems: "flex-end", flexWrap: "wrap", marginTop: SPACE.md }}>
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
            <span style={{ fontSize: TEXT.small, color: COLOR.ok, paddingBottom: SPACE.sm }}>연결됨</span>
          )}
        </div>
      </Card>

      {/* ── 노션 연결 ─────────────────────────────────── */}
      {/*
        Jira 계정 연결과 나란히 두지만 성격이 다르다 — Jira 쪽은 **공개 식별자**이고,
        이쪽은 **내 노션에 쓰는 열쇠**다. 그래서 저장된 값을 되돌려주지 않고(있다/없다만),
        암호화 키가 없으면 저장 자체를 거부한다.
      */}
      <Card style={{ padding: SPACE.xl, marginBottom: SPACE.lg }}>
        <h2 style={sectionTitle}>노션 연결</h2>
        <p style={hintStyle}>
          <a href="/notes" style={{ color: COLOR.accent }}>메모장</a>의 메모를{" "}
          <strong>내 노션</strong>으로 올릴 때 씁니다. 연결은 <strong>사람마다 따로</strong>이고,
          올리면 아래 페이지 아래에 메모 한 건이 페이지 하나로 만들어집니다. 저장할 때 따라
          나가지 않습니다 — 메모장에서 올리기를 누를 때만 나갑니다.
        </p>
        <ol style={{ ...hintStyle, margin: `${SPACE.sm}px 0 0`, paddingLeft: 18 }}>
          <li>
            <a href="https://www.notion.so/my-integrations" target="_blank" rel="noreferrer"
               style={{ color: COLOR.accent }}>notion.so/my-integrations</a>{" "}
            에서 integration 을 만들고 <strong>Internal Integration Secret</strong> 을 복사합니다
            (<span style={{ fontFamily: MONO_STACK }}>ntn_…</span>).
          </li>
          <li>
            메모를 모아 둘 노션 <strong>페이지</strong>를 하나 만들고, 그 페이지의{" "}
            <span style={{ fontFamily: MONO_STACK }}>…</span> 메뉴 →{" "}
            <strong>연결 추가</strong>로 그 integration 을 공유합니다.
            <span style={{ color: COLOR.waitUs }}> 이걸 빠뜨리면 404 가 옵니다.</span>
          </li>
          <li>그 페이지 주소를 아래에 붙여 넣습니다. 주소를 그대로 넣어도 됩니다.</li>
        </ol>

        {!notionState.canSave && (
          <div style={{ marginTop: SPACE.md }}>
            <Notice tone="warn">
              암호화 키(<span style={{ fontFamily: MONO_STACK }}>SR_SECRET_KEY</span>)가 없어 토큰을
              저장할 수 없습니다. 평문으로는 저장하지 않습니다 — 서버에 키를 넣어야 합니다.
            </Notice>
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: SPACE.sm, marginTop: SPACE.md }}>
          <input
            type="password"
            value={notionToken}
            onChange={(e) => setNotionToken(e.target.value)}
            placeholder={notionState.hasToken ? "토큰 (바꿀 때만 입력 — 비우면 그대로 둡니다)" : "ntn_…"}
            autoComplete="off"
            style={{ ...controlStyle, cursor: "text", fontFamily: MONO_STACK }}
          />
          <input
            value={notionPage}
            onChange={(e) => setNotionPage(e.target.value)}
            placeholder="https://www.notion.so/… (메모를 모아 둘 페이지)"
            style={{ ...controlStyle, cursor: "text", fontFamily: MONO_STACK }}
          />
          <div style={{ display: "flex", gap: SPACE.sm, alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={busy || !notionState.canSave || notionPage.trim() === ""}
              onClick={() => {
                void post(
                  { action: "notion_connect", token: notionToken, parentPage: notionPage },
                  "노션을 연결했습니다.",
                ).then((data) => {
                  const next = data?.notion as NotionAccountMeta | undefined;
                  if (next === undefined) return;
                  setNotionState(next);
                  setNotionPage(next.parentPageId);
                  // 저장된 토큰은 돌려받지 않는다. 칸을 비워 "저장됨" 과 입력칸을 섞지 않는다.
                  setNotionToken("");
                });
              }}
              style={{ ...controlStyle, opacity: busy ? 0.6 : 1 }}
            >
              저장
            </button>
            {notionState.ready ? (
              <span style={{ fontSize: TEXT.small, color: COLOR.ok }}>연결됨</span>
            ) : notionState.hasToken ? (
              <span style={{ fontSize: TEXT.small, color: COLOR.waitUs }}>
                올릴 페이지가 없습니다
              </span>
            ) : (
              <span style={{ fontSize: TEXT.small, color: COLOR.faint }}>연결 안 됨</span>
            )}
            {notionState.hasToken && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void post({ action: "notion_clear" }, "노션 연결을 끊었습니다.").then((data) => {
                    const next = data?.notion as NotionAccountMeta | undefined;
                    if (next === undefined) return;
                    setNotionState(next);
                    setNotionPage("");
                    setNotionToken("");
                  });
                }}
                style={{ ...controlStyle, opacity: busy ? 0.6 : 1 }}
              >
                연결 끊기
              </button>
            )}
          </div>
          <p style={{ ...hintStyle, margin: 0 }}>
            연결을 끊어도 <strong>이미 올린 노션 페이지는 남습니다</strong> — 필요하면 노션에서
            직접 지워주세요. 다시 연결하면 그 페이지를 이어 씁니다.
          </p>
        </div>
      </Card>

      {/* ── 비밀번호 ──────────────────────────────────── */}
      <Card style={{ padding: SPACE.xl }}>
        <h2 style={sectionTitle}>비밀번호 변경</h2>
        <p style={hintStyle}>
          이 도구의 로그인 비밀번호입니다 — 브로드컴 포털 계정과 다릅니다. 바꾸면{" "}
          <strong>모든 기기에서 로그아웃</strong>됩니다(이 브라우저까지).
        </p>
        <div style={{ display: "flex", gap: SPACE.sm, flexWrap: "wrap", marginTop: SPACE.md }}>
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
      <div style={{ fontSize: TEXT.micro, color: COLOR.faint, fontWeight: WEIGHT.semibold }}>{label}</div>
      <div style={{
        fontSize: TEXT.base, marginTop: SPACE.xxs, fontWeight: WEIGHT.medium,
        fontFamily: mono === true ? MONO_STACK : "inherit",
      }}>
        {value}
      </div>
    </div>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: TEXT.lead,
  fontWeight: WEIGHT.bold,
  margin: `0 0 ${SPACE.md}px`,
  letterSpacing: "-0.01em",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: TEXT.small,
  fontWeight: WEIGHT.semibold,
  color: COLOR.body,
  marginBottom: SPACE.xs,
};

const hintStyle: React.CSSProperties = {
  margin: 0,
  fontSize: TEXT.small,
  color: COLOR.muted,
  lineHeight: 1.75,
};
