/**
 * 개인 노션 연결 — 저장·조회.
 *
 * ## 왜 사람별인가
 *
 * 노션 integration 토큰은 **그 사람의 노션에 쓰는 열쇠**다. 팀 하나로 두면 한 사람의
 * 노션이 팀 전체에 열린다. 그리고 메모를 올릴 자리(부모 페이지)도 각자 다르다 — 자기
 * 업무 공간 아래에 둔다. 그래서 users 행에 붙인다.
 *
 * 메모 자체는 팀 공유다. 올리는 것만 개인 행동이다 — 같은 메모를 두 사람이 올리면
 * 각자의 노션에 각자의 페이지가 생긴다(note_notion_pages 가 그 짝을 들고 있다).
 *
 * ## 안전장치 (lib/portalCredentials.ts 와 같은 규약)
 *
 *   - 토큰은 AES-256-GCM 으로만 저장한다(lib/secretBox.ts). 키(SR_SECRET_KEY)가 없으면
 *     **저장을 거부**한다 — 평문 폴백은 없다.
 *   - 화면용(readNotionAccountMeta)은 토큰을 돌려주지 않는다. 있다/없다와 부모 페이지만
 *     돌려준다.
 *   - 복호화에 실패하면(키가 바뀐 경우 등) **조용히 넘기지 않고** 터뜨린다. 조용히 넘기면
 *     "연결했는데 안 올라간다" 가 되고 이유를 알 길이 없다.
 *
 * server-only 를 붙이지 않는다 — 수집기에서 부를 일은 없지만, 이 레포의 lib 규약을
 * 따른다(자격을 다루는 모듈은 라우트와 스크립트 양쪽에서 쓰인다).
 */
import type { Db } from "./db.ts";
import { normalizePageId } from "./notion.ts";
import { decryptSecret, encryptSecret, hasSecretKey } from "./secretBox.ts";

/** 화면용. 토큰은 담기지 않는다. */
export interface NotionAccountMeta {
  readonly hasToken: boolean;
  readonly parentPageId: string;
  /** 둘 다 있어야 올릴 수 있다. */
  readonly ready: boolean;
  /** 암호화 키가 없어 저장 자체가 막혀 있는가. 화면이 그 사실을 말해야 한다. */
  readonly canSave: boolean;
}

export class NotionAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotionAccountError";
  }
}

interface Row {
  notion_token_enc: string;
  notion_parent_page: string;
}

async function rowOf(db: Db, userId: number): Promise<Row | null> {
  const row = await db.get<Row>(
    "SELECT notion_token_enc, notion_parent_page FROM users WHERE user_id = ?",
    [userId],
  );
  return row === undefined || row === null ? null : row;
}

export async function readNotionAccountMeta(db: Db, userId: number): Promise<NotionAccountMeta> {
  const row = await rowOf(db, userId);
  const hasToken = (row?.notion_token_enc ?? "") !== "";
  const parentPageId = row?.notion_parent_page ?? "";
  return {
    hasToken,
    parentPageId,
    ready: hasToken && parentPageId !== "",
    canSave: hasSecretKey(),
  };
}

/**
 * 올릴 때 쓰는 값. **평문 토큰이 담긴다** — 화면·HTTP 응답에 실어 보내면 안 된다.
 *
 * 둘 중 하나라도 없으면 null 이다. 부르는 쪽이 "연결 안 됨" 을 그대로 보여 준다.
 */
export async function readNotionAccount(
  db: Db,
  userId: number,
): Promise<{ token: string; parentPageId: string } | null> {
  const row = await rowOf(db, userId);
  if (row === null) return null;
  const enc = row.notion_token_enc ?? "";
  const parentPageId = row.notion_parent_page ?? "";
  if (enc === "" || parentPageId === "") return null;
  // 복호화 실패는 던진다. 조용히 null 로 내리면 "연결했는데 안 올라간다" 가 된다.
  return { token: decryptSecret(enc), parentPageId };
}

/**
 * 연결을 저장한다.
 *
 * 부모 페이지는 주소를 그대로 붙여 넣어도 받는다 — 사람이 노션 주소를 복사해 오는 것이
 * 가장 흔한 흐름이다. 못 알아보면 **거절한다.** 그대로 보냈다가 404 를 받으면, 그 404 는
 * "공유를 안 했다" 와 구분이 안 되어 엉뚱한 곳을 의심하게 된다.
 */
export async function saveNotionAccount(
  db: Db,
  userId: number,
  input: { readonly token: string; readonly parentPage: string },
): Promise<NotionAccountMeta> {
  const token = input.token.trim();
  const parentPageId = normalizePageId(input.parentPage);

  if (parentPageId === "") {
    throw new NotionAccountError(
      "노션 페이지 주소를 알아볼 수 없습니다. 페이지 주소를 그대로 붙여 넣거나 32자 id 를 넣어주세요.",
    );
  }
  if (!hasSecretKey()) {
    throw new NotionAccountError(
      "암호화 키(SR_SECRET_KEY)가 없어 토큰을 저장할 수 없습니다. 평문으로는 저장하지 않습니다.",
    );
  }

  /*
   * 토큰을 비워 보내면 **있던 토큰을 지키고 부모 페이지만 바꾼다.**
   *
   * 화면이 토큰을 돌려주지 않으므로(돌려주면 그게 유출 경로다), 부모 페이지만 고치려는
   * 사람은 토큰 칸을 빈 채로 저장한다. 그때 토큰을 지우면 연결이 조용히 끊긴다.
   */
  if (token === "") {
    const row = await rowOf(db, userId);
    if ((row?.notion_token_enc ?? "") === "") {
      throw new NotionAccountError("노션 integration 토큰이 필요합니다.");
    }
    await db.run("UPDATE users SET notion_parent_page = ? WHERE user_id = ?", [parentPageId, userId]);
    return readNotionAccountMeta(db, userId);
  }

  await db.run(
    "UPDATE users SET notion_token_enc = ?, notion_parent_page = ? WHERE user_id = ?",
    [encryptSecret(token), parentPageId, userId],
  );
  return readNotionAccountMeta(db, userId);
}

/**
 * 연결을 끊는다.
 *
 * **이미 올린 노션 페이지는 지우지 않는다.** 그건 그 사람의 노션에 있는 글이고, 지우는
 * 것은 다른 결정이다. 올린 기록(note_notion_pages)도 남긴다 — 다시 연결하면 같은
 * 페이지를 이어 쓰는 것이 맞다.
 */
export async function clearNotionAccount(db: Db, userId: number): Promise<NotionAccountMeta> {
  await db.run(
    "UPDATE users SET notion_token_enc = '', notion_parent_page = '' WHERE user_id = ?",
    [userId],
  );
  return readNotionAccountMeta(db, userId);
}
