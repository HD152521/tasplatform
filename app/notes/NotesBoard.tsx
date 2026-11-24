"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  COLOR,
  Card,
  Empty,
  MONO_STACK,
  Notice,
  RADIUS,
  SPACE,
  TEXT,
  WEIGHT,
  controlStyle,
  formatStamp,
} from "../ui.tsx";
import type { MemberChip } from "../calendar/CalendarBoard.tsx";
import { MemoBody } from "../calendar/MemoBody.tsx";
import { TokenInput } from "../calendar/TokenInput.tsx";
import type { TeamNoteView } from "../../lib/notes.ts";
import { clearDraft, draftKey, loadDraft, saveDraft } from "../../lib/draftStore.ts";

/**
 * 메모장 화면.
 *
 * ## 왼쪽 목록 · 오른쪽 내용
 *
 * 메모는 "찾아서 다시 읽는" 글이다. 한 건씩 펼쳐 보는 목록이면 찾는 동안 화면이 계속
 * 튄다. 그래서 목록과 내용을 나눠 두고, 고른 것만 오른쪽에 그린다.
 *
 * ## 쓰던 글은 붙잡아 둔다
 *
 * 긴 글을 쓰다 새로고침하거나 다른 메모를 눌러도 사라지지 않게 브라우저에 남긴다
 * (lib/draftStore.ts — 답변 작성란이 같은 이유로 쓰는 장치다). 메모장은 "적어 두는
 * 자리" 라 쓰다 만 글이 사라지면 그 자리를 다시 안 쓴다.
 *
 * ## 노션은 사람이 누를 때만
 *
 * 저장과 올리기가 **다른 버튼**이다. 저장이 따라 나가면 적는 동안 밖으로 흘러간다.
 * 올린 뒤에 글을 고치면 "노션 쪽이 옛 내용" 임을 그 자리에서 보여 준다 — 그 표시가
 * 없으면 사람은 노션도 같이 바뀐 줄 안다.
 */
export function NotesBoard({
  initialNotes,
  members,
  notionReady,
  focusNoteId,
}: {
  initialNotes: readonly TeamNoteView[];
  members: readonly MemberChip[];
  notionReady: boolean;
  focusNoteId: number | null;
}) {
  const [notes, setNotes] = useState<readonly TeamNoteView[]>(initialNotes);
  const [openId, setOpenId] = useState<number | null>(focusNoteId ?? initialNotes[0]?.noteId ?? null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "warn"; text: string } | null>(null);

  /** 읽는 중인가, 적는 중인가. */
  const [mode, setMode] = useState<"read" | "write">("read");
  /**
   * 고치는 중인 메모 번호. null 이면 **새 메모**다.
   *
   * mode 와 나눠 둔다. 하나로 섞으면 "새로 적는 중" 과 "1번을 고치는 중" 을 구분할 수
   * 없고, 그러면 저장이 POST 와 PATCH 중 어디로 가야 하는지 알 수 없다.
   */
  const [editId, setEditId] = useState<number | null>(null);
  const [draft, setDraft] = useState({ title: "", body: "", tags: "" });
  const titleRef = useRef<HTMLInputElement | null>(null);

  const open = notes.find((n) => n.noteId === openId) ?? null;

  /*
   * 새 메모의 글은 **아직 저장되지 않은** 유일한 글이다. 그래서 그것만 브라우저에
   * 붙잡아 둔다 — 고치는 중인 글은 서버에 원본이 남아 있다.
   */
  const newKey = draftKey("note", 0);
  const [loadedDraft, setLoadedDraft] = useState(false);
  useEffect(() => {
    const saved = loadDraft(newKey);
    if (saved !== "") {
      try {
        const parsed = JSON.parse(saved) as { title?: string; body?: string; tags?: string };
        setDraft({ title: parsed.title ?? "", body: parsed.body ?? "", tags: parsed.tags ?? "" });
        setMode("write");
      } catch {
        // 깨진 값은 버린다. 빈 칸으로 시작하는 것이 낫다.
      }
    }
    setLoadedDraft(true);
  }, [newKey]);

  const writingNew = mode === "write" && editId === null;
  useEffect(() => {
    if (!loadedDraft) return;
    if (writingNew) saveDraft(newKey, JSON.stringify(draft));
  }, [draft, loadedDraft, newKey, writingNew]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return notes;
    return notes.filter(
      (n) =>
        n.title.toLowerCase().includes(q)
        || n.body.toLowerCase().includes(q)
        || n.tags.toLowerCase().includes(q),
    );
  }, [notes, query]);

  async function reload(): Promise<void> {
    try {
      const res = await fetch("/api/notes");
      const data = (await res.json()) as { ok?: boolean; notes?: TeamNoteView[] };
      if (data.ok === true) setNotes(data.notes ?? []);
    } catch {
      // 목록을 못 읽어도 지금 보고 있는 메모는 그대로 둔다.
    }
  }

  async function save(): Promise<void> {
    if (draft.title.trim() === "") return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/notes", {
        method: editId === null ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editId === null ? draft : { ...draft, noteId: editId }),
      });
      const data = (await res.json()) as { ok?: boolean; message?: string; note?: TeamNoteView };
      if (data.ok !== true) {
        setMessage({ tone: "error", text: data.message ?? "저장하지 못했습니다." });
        return;
      }
      if (editId === null) clearDraft(newKey);
      setMode("read");
      setEditId(null);
      setDraft({ title: "", body: "", tags: "" });
      await reload();
      if (data.note !== undefined) setOpenId(data.note.noteId);
      setMessage({ tone: "ok", text: editId === null ? "메모를 저장했습니다." : "메모를 고쳤습니다." });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function remove(note: TeamNoteView): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/notes?noteId=${note.noteId}`, { method: "DELETE" });
      const data = (await res.json()) as { ok?: boolean; message?: string };
      if (data.ok !== true) {
        setMessage({ tone: "error", text: data.message ?? "지우지 못했습니다." });
        return;
      }
      setOpenId(null);
      await reload();
      // 노션 페이지가 남았다는 안내가 오면 그대로 보여 준다 — 사람이 할 일이 있다.
      setMessage({ tone: note.notionPageId === "" ? "ok" : "warn", text: data.message ?? "지웠습니다." });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function toNotion(noteId: number): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "to-notion", noteId }),
      });
      const data = (await res.json()) as { ok?: boolean; message?: string };
      await reload();
      setMessage({
        tone: data.ok === true ? "ok" : "error",
        text: data.message ?? (data.ok === true ? "노션에 올렸습니다." : "올리지 못했습니다."),
      });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  function startNew(): void {
    setEditId(null);
    setMode("write");
    setMessage(null);
    // 붙잡아 둔 글이 있으면 그것을 이어 쓴다 — 비우면 쓰다 만 글이 사라진다.
    setTimeout(() => titleRef.current?.focus(), 0);
  }

  function startEdit(note: TeamNoteView): void {
    setEditId(note.noteId);
    setDraft({ title: note.title, body: note.body, tags: note.tags });
    setMode("write");
    setMessage(null);
    setTimeout(() => titleRef.current?.focus(), 0);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: SPACE.lg }}>
      {message !== null && <Notice tone={message.tone}>{message.text}</Notice>}
      {!notionReady && (
        <Notice tone="info">
          노션 연동이 아직 설정되지 않았습니다 — 메모는 저장되지만 올릴 수 없습니다.
          <code style={{ marginLeft: 6, fontSize: 12 }}>NOTION_TOKEN</code> ·{" "}
          <code style={{ fontSize: 12 }}>NOTION_PARENT_PAGE</code> 를 넣고, 노션에서 그 페이지를
          integration 에 공유해 주세요.
        </Notice>
      )}

      <div style={{ display: "flex", gap: SPACE.lg, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* ── 목록 ───────────────────────────────── */}
        <Card style={{ flex: "0 0 300px", minWidth: 260, padding: SPACE.md }}>
          <div style={{ display: "flex", gap: SPACE.sm, marginBottom: SPACE.md }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="제목·내용·태그 찾기"
              style={{ ...controlStyle, flex: 1, minWidth: 0, cursor: "text" }}
            />
            <Button kind="primary" size="small" onClick={startNew}>
              새 메모
            </Button>
          </div>

          {shown.length === 0 ? (
            <Empty>{query.trim() === "" ? "아직 메모가 없습니다." : "찾는 메모가 없습니다."}</Empty>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {shown.map((note) => (
                <button
                  key={note.noteId}
                  type="button"
                  onClick={() => {
                    setOpenId(note.noteId);
                    // 읽기로 돌아간다. 고치던 중에 다른 메모를 누르면 어느 글을 고치는지
                    // 알 수 없게 된다.
                    setMode("read");
                    setEditId(null);
                  }}
                  style={{
                    textAlign: "left", border: "none", cursor: "pointer", fontFamily: "inherit",
                    background: note.noteId === openId ? COLOR.accentWash : "transparent",
                    borderRadius: 8, padding: `${SPACE.sm}px ${SPACE.md}px`,
                    display: "flex", flexDirection: "column", gap: 2,
                  }}
                >
                  <span style={{
                    fontSize: TEXT.base, fontWeight: note.noteId === openId ? WEIGHT.semibold : 400,
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    color: COLOR.ink,
                  }}>
                    {note.title}
                  </span>
                  <span style={{
                    fontSize: TEXT.micro, color: COLOR.faint, display: "flex", gap: SPACE.xs,
                    alignItems: "center", flexWrap: "nowrap", overflow: "hidden",
                  }}>
                    <span style={{ fontFamily: MONO_STACK, flexShrink: 0 }}>
                      {note.updatedAt.slice(5, 10)}
                    </span>
                    {note.notionState === "ok" && (
                      <span style={{ color: COLOR.ok, flexShrink: 0 }}>노션</span>
                    )}
                    {note.notionState === "failed" && (
                      <span style={{ color: COLOR.waitUs, flexShrink: 0 }}>올리기 실패</span>
                    )}
                    {note.tags !== "" && (
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {note.tags}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Card>

        {/* ── 내용 ───────────────────────────────── */}
        <div style={{ flex: "1 1 420px", minWidth: 320 }}>
          {mode === "write" ? (
            <Card style={{ padding: SPACE.lg }}>
              <div style={{ display: "flex", flexDirection: "column", gap: SPACE.md }}>
                <div style={{ fontSize: TEXT.small, color: COLOR.faint, fontWeight: WEIGHT.semibold }}>
                  {editId === null ? "새 메모" : `메모 #${editId} 고치는 중`}
                </div>
                <input
                  ref={titleRef}
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  placeholder="제목 (예: 11/24 TAS 업그레이드 사전 점검 메모)"
                  style={{ ...controlStyle, width: "100%", cursor: "text", fontWeight: WEIGHT.semibold }}
                />
                {/*
                  `@` 를 치면 팀원 목록이 뜬다. 노션 멘션은 만들 수 없지만(계정 id 를
                  모른다) 이름으로 펴서 올라가고, 우리 화면에서는 강조된다.
                */}
                <TokenInput
                  value={draft.body}
                  onChange={(body) => setDraft({ ...draft, body })}
                  members={members}
                  triggers={["@"]}
                  multiline
                  rows={14}
                  placeholder={"내용\n- 줄머리에 - 를 적으면 목록이 됩니다\n- 빈 줄을 두면 문단이 나뉩니다\n@이름 도 알아봅니다"}
                />
                <input
                  value={draft.tags}
                  onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
                  placeholder="태그 (쉼표로 구분 — 찾을 때만 씁니다)"
                  style={{ ...controlStyle, width: "100%", cursor: "text" }}
                />

                {draft.body.trim() !== "" && (
                  <div style={{
                    background: COLOR.ground, borderRadius: RADIUS.control, padding: `${SPACE.md}px`,
                  }}>
                    <div style={{
                      fontSize: TEXT.micro, fontWeight: WEIGHT.semibold, color: COLOR.faint,
                      marginBottom: SPACE.xs,
                    }}>
                      이렇게 보입니다 — 노션에도 같은 모양으로 올라갑니다
                    </div>
                    <MemoBody text={draft.body} members={members} />
                  </div>
                )}

                <div style={{ display: "flex", gap: SPACE.sm }}>
                  <Button
                    kind="primary"
                    onClick={() => void save()}
                    disabled={busy || draft.title.trim() === ""}
                  >
                    {busy ? "저장 중…" : "저장"}
                  </Button>
                  <Button
                    onClick={() => {
                      setMode("read");
                      setEditId(null);
                      setDraft({ title: "", body: "", tags: "" });
                    }}
                    disabled={busy}
                  >
                    취소
                  </Button>
                  {editId === null && (
                    <span style={{ fontSize: TEXT.micro, color: COLOR.faint, alignSelf: "center" }}>
                      쓰던 글은 이 브라우저에 남습니다.
                    </span>
                  )}
                </div>
              </div>
            </Card>
          ) : open === null ? (
            <Card style={{ padding: SPACE.lg }}>
              <Empty>왼쪽에서 메모를 고르거나 「새 메모」를 누르세요.</Empty>
            </Card>
          ) : (
            <NoteDetail
              note={open}
              members={members}
              notionReady={notionReady}
              busy={busy}
              onEdit={() => startEdit(open)}
              onDelete={() => void remove(open)}
              onToNotion={() => void toNotion(open.noteId)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** 고른 메모 한 건. */
function NoteDetail({
  note, members, notionReady, busy, onEdit, onDelete, onToNotion,
}: {
  note: TeamNoteView;
  members: readonly MemberChip[];
  notionReady: boolean;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onToNotion: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  /*
   * 노션 쪽이 옛 내용인가.
   *
   * 올린 뒤에 글을 고치면 노션은 그대로다. 그 사실을 말해 주지 않으면 사람은 노션도
   * 같이 바뀐 줄 알고, 그 페이지를 보는 사람은 옛 글을 읽는다.
   */
  const stale =
    note.notionState === "ok"
    && note.notionSyncedAt !== ""
    && note.updatedAt > note.notionSyncedAt;

  return (
    <Card style={{ padding: SPACE.lg }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: SPACE.md }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: WEIGHT.bold, letterSpacing: "-0.01em" }}>
            {note.title}
          </div>
          <div style={{ fontSize: TEXT.small, color: COLOR.muted, marginTop: SPACE.xs, lineHeight: 1.8 }}>
            {note.createdByName === "" ? "작성자 미상" : note.createdByName}
            {" · 고침 "}
            <span style={{ fontFamily: MONO_STACK }}>{formatStamp(Date.parse(note.updatedAt))}</span>
            {note.tags !== "" && ` · ${note.tags}`}
          </div>
        </div>
        <div style={{ display: "flex", gap: SPACE.sm, flexShrink: 0 }}>
          <Button size="small" onClick={onEdit} disabled={busy}>고치기</Button>
          {confirming ? (
            <>
              <Button size="small" kind="danger" onClick={onDelete} disabled={busy}>
                정말 지우기
              </Button>
              <Button size="small" onClick={() => setConfirming(false)} disabled={busy}>
                취소
              </Button>
            </>
          ) : (
            <Button size="small" kind="quiet" onClick={() => setConfirming(true)} disabled={busy}>
              지우기
            </Button>
          )}
        </div>
      </div>

      <div style={{ marginTop: SPACE.lg }}>
        {note.body.trim() === "" ? (
          <p style={{ margin: 0, fontSize: TEXT.base, color: COLOR.faint }}>내용이 비어 있습니다.</p>
        ) : (
          <MemoBody text={note.body} members={members} />
        )}
      </div>

      {/* ── 노션 ───────────────────────────────── */}
      <div style={{
        marginTop: SPACE.lg, paddingTop: SPACE.md, borderTop: `1px solid ${COLOR.divider}`,
        display: "flex", alignItems: "center", gap: SPACE.md, flexWrap: "wrap",
      }}>
        <span style={{ fontSize: TEXT.small, fontWeight: WEIGHT.semibold, color: COLOR.body }}>
          노션
        </span>
        {note.notionUrl !== "" ? (
          <a
            href={note.notionUrl}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: TEXT.small, color: COLOR.accent, fontWeight: WEIGHT.semibold }}
          >
            올린 페이지 열기
          </a>
        ) : (
          <span style={{ fontSize: TEXT.small, color: COLOR.faint }}>
            {note.notionState === "failed" ? "올리지 못했습니다" : "아직 안 올렸습니다"}
          </span>
        )}
        {stale && (
          <span style={{ fontSize: TEXT.small, color: COLOR.waitUs }}>
            올린 뒤에 고쳤습니다 — 노션 쪽은 옛 내용입니다
          </span>
        )}
        {note.notionTries > 1 && (
          <span style={{ fontSize: TEXT.micro, color: COLOR.faint }}>{note.notionTries}회 실패</span>
        )}
        <Button size="small" onClick={onToNotion} disabled={busy || !notionReady}>
          {note.notionPageId === "" ? "노션에 올리기" : "노션 다시 올리기"}
        </Button>
      </div>
      {note.notionError !== "" && (
        <p style={{ margin: `${SPACE.sm}px 0 0`, fontSize: TEXT.micro, color: COLOR.waitUs, lineHeight: 1.7 }}>
          {note.notionError}
        </p>
      )}
    </Card>
  );
}
