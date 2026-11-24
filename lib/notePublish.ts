/**
 * 메모 한 건을 노션 페이지로 올린다.
 *
 * ## 사람이 고른 것만 나간다
 *
 * 자동으로 올리는 길을 두지 않았다. 쓸어 올리는 회차도 없다. 메모장에는 고객사 상황이
 * 적힐 수 있고, 올린 글은 지워도 이미 읽힌 뒤다. 그래서 캘린더 메모를 Jira 코멘트로
 * 보내는 쪽과 같은 규약을 쓴다(lib/calendarJira.ts postNoteToJira).
 *
 * ## 두 번 올려도 페이지는 하나다
 *
 * 처음 올리면 페이지를 만들고 그 id 를 적어 둔다(team_notes.notion_page_id). 다시
 * 올리면 그 페이지의 **내용을 바꾼다** — 새 페이지를 만들지 않는다. 노션에는 "내용
 * 통째로 바꾸기" 가 없어서, 있던 자식 블록을 지우고 새로 붙인다.
 *
 * 지우는 중에 실패하면 옛 글과 새 글이 섞여 남는다. 그걸 조용히 넘기지 않고 **그렇게
 * 말한다** — 노션을 열어 봐야 하는 상태인데 "실패했습니다" 만 보면 아무도 안 열어 본다.
 *
 * ## 던지지 않는다
 *
 * 결과를 돌려준다. 노션이 꺼져 있거나 죽어 있어도 메모장은 동작한다 — 캘린더가 Jira
 * 없이 동작하는 것과 같은 규약이다.
 */
import "server-only";
import { appUrl } from "./appUrl.ts";
import type { Db } from "./db.ts";
import type { MentionablePerson } from "./mentionSpans.ts";
import {
  appendBlocks,
  createPage,
  deleteBlock,
  listChildBlockIds,
  notionConfig,
  notionFailureText,
  updateTitle,
  type NotionConfig,
} from "./notion.ts";
import {
  notionBlockBatches,
  notionBlocksOf,
  notionFooter,
  type NotionBlock,
} from "./notionBlocks.ts";
import { getNote, recordNotionResult, type NotionState, type TeamNote } from "./notes.ts";
import { listTeamMembers } from "./users.ts";

export interface NotePublishResult {
  /** 무엇을 했나. 화면이 그대로 보여 준다. */
  readonly action: "skipped" | "created" | "updated" | "failed";
  readonly pageId: string;
  readonly url: string;
  readonly state: NotionState;
  /** 사람에게 보여 줄 한 줄. 실패 사유도 여기 담는다. */
  readonly message: string;
}

function skipped(message: string): NotePublishResult {
  return { action: "skipped", pageId: "", url: "", state: "none", message };
}

/** 노션 연동이 설정돼 있는가. 화면이 버튼을 보일지 정하는 데 쓴다. */
export function notionReady(): boolean {
  return notionConfig() !== null;
}

/**
 * `@이름` 을 맞출 팀원 목록.
 *
 * 노션 멘션을 만들지는 못한다(노션 계정 id 를 모른다 — lib/notionBlocks.ts 머리말).
 * 그래도 목록을 넘기는 이유는, 적힌 `@yongsik` 을 **사람 이름으로 펴서** 올리기
 * 위해서다. 로그인 아이디로 남으면 노션에서 본 사람이 누군지 모른다.
 */
async function mentionable(db: Db, teamId: string): Promise<MentionablePerson[]> {
  const members = await listTeamMembers(db, teamId).catch(() => []);
  return members.map((m) => ({
    displayName: m.displayName,
    loginId: m.loginId,
    jiraAccountId: m.jiraAccountId,
  }));
}

/** 올릴 블록. 본문 + 어디서 왔는지 한 문단. */
async function blocksFor(db: Db, teamId: string, note: TeamNote): Promise<NotionBlock[]> {
  const people = await mentionable(db, teamId);
  const author = note.createdBy === null
    ? ""
    : (await listTeamMembers(db, teamId).catch(() => []))
        .find((m) => m.userId === note.createdBy)?.displayName ?? "";

  return [
    ...notionBlocksOf(note.body, people),
    notionFooter({
      author,
      updatedAt: note.updatedAt,
      appUrl: appUrl(),
      noteId: note.noteId,
    }),
  ];
}

export async function publishNoteToNotion(
  db: Db,
  teamId: string,
  noteId: number,
): Promise<NotePublishResult> {
  const config = notionConfig();
  if (config === null) {
    // 상태를 건드리지 않는다 — "실패" 로 적으면 설정만 안 한 것이 고장으로 보인다.
    return skipped(
      "노션 연동이 설정되지 않았습니다. NOTION_TOKEN 과 NOTION_PARENT_PAGE 를 넣어주세요.",
    );
  }

  const note = await getNote(db, teamId, noteId);
  if (note === null) return skipped("그 메모를 찾을 수 없습니다.");

  try {
    const blocks = await blocksFor(db, teamId, note);
    return note.notionPageId === ""
      ? await createFor(db, config, teamId, note, blocks)
      : await replaceFor(db, config, teamId, note, blocks);
  } catch (error) {
    const message = notionFailureText(error);
    await recordNotionResult(db, teamId, noteId, { state: "failed", error: message });
    return {
      action: "failed",
      pageId: note.notionPageId,
      url: note.notionUrl,
      state: "failed",
      message,
    };
  }
}

async function createFor(
  db: Db,
  config: NotionConfig,
  teamId: string,
  note: TeamNote,
  blocks: readonly NotionBlock[],
): Promise<NotePublishResult> {
  const batches = notionBlockBatches(blocks);
  const page = await createPage(config, { title: note.title, blocks: batches[0] ?? [] });

  /*
   * 페이지가 만들어진 **직후에** id 를 적는다.
   *
   * 나머지 블록을 붙이다 실패해도 페이지는 이미 있다. 그때 id 를 안 적어 두면 다음
   * 올리기가 그 페이지를 못 찾아 **같은 글로 페이지를 하나 더** 만든다.
   */
  await recordNotionResult(db, teamId, note.noteId, {
    pageId: page.pageId,
    url: page.url,
    state: "ok",
  });

  for (const batch of batches.slice(1)) {
    await appendBlocks(config, page.pageId, batch);
  }

  return {
    action: "created",
    pageId: page.pageId,
    url: page.url,
    state: "ok",
    message: "노션에 페이지를 만들었습니다.",
  };
}

async function replaceFor(
  db: Db,
  config: NotionConfig,
  teamId: string,
  note: TeamNote,
  blocks: readonly NotionBlock[],
): Promise<NotePublishResult> {
  const pageId = note.notionPageId;
  await updateTitle(config, pageId, note.title);

  const existing = await listChildBlockIds(config, pageId);
  let removed = 0;
  try {
    for (const blockId of existing) {
      await deleteBlock(config, blockId);
      removed += 1;
    }
  } catch (error) {
    /*
     * 지우다 멈췄다. 여기서 새 글을 붙이면 **옛 글과 새 글이 섞여** 남는다. 붙이지
     * 않고 멈추고, 노션을 열어 봐야 하는 상태라고 말한다 — "실패했습니다" 만 보면
     * 아무도 열어 보지 않는다.
     */
    const detail = notionFailureText(error);
    const message =
      `노션 페이지의 이전 내용을 지우다 멈췄습니다(${removed}/${existing.length}줄).`
      + ` 새 내용은 붙이지 않았습니다 — 페이지를 열어 확인해 주세요. (${detail})`;
    await recordNotionResult(db, teamId, note.noteId, { state: "failed", error: message });
    return { action: "failed", pageId, url: note.notionUrl, state: "failed", message };
  }

  for (const batch of notionBlockBatches(blocks)) {
    await appendBlocks(config, pageId, batch);
  }

  await recordNotionResult(db, teamId, note.noteId, {
    pageId,
    url: note.notionUrl,
    state: "ok",
  });
  return {
    action: "updated",
    pageId,
    url: note.notionUrl,
    state: "ok",
    message:
      removed === 0
        ? "노션 페이지를 새로 채웠습니다."
        : `노션 페이지를 다시 채웠습니다(이전 내용 ${removed}줄을 지웠습니다).`,
  };
}
