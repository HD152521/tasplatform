/**
 * 포털(브로드컴) 공용 계정 자격 — 저장·조회.
 *
 * ## 왜 DB 로 옮기는가
 *
 * 이 계정은 **주기적으로 비밀번호를 바꾸는 공용 계정**이다. 그런데 값이 `.env` 에만
 * 있어서, 회전마다 사람이 사본 **세 군데**(작업 PC·수집기 VM·TAS 드롭릿)를 찾아 고치고
 * 재배포해야 했다. 한 곳을 빠뜨리면 그 프로세스가 옛 비밀번호로 계속 로그인을 시도하고,
 * 그게 공용 계정을 잠근다(그 사고를 막는 쪽은 lib/loginGuard.ts).
 *
 * 그래서 화면에서 바꿀 수 있게 DB 에 둔다. 웹과 수집기가 같은 DB 를 보므로 한 번
 * 저장하면 양쪽이 같은 값을 쓴다.
 *
 * ## 안전장치
 *
 *   - 비밀번호는 AES-256-GCM 으로만 저장한다(lib/secretBox.ts). 키(SR_SECRET_KEY)가
 *     없으면 **저장을 거부**한다 — 평문 폴백은 없다.
 *   - 화면용(getPortalCredentialsMeta)은 평문도 암호문도 돌려주지 않는다. 있다/없다와
 *     아이디만 돌려준다.
 *   - 복호화에 실패하면(키가 바뀐 경우 등) **조용히 .env 로 내려가지 않는다.** 내려가면
 *     옛 비밀번호로 시도해 잠금 위험을 만들기 때문이다. 터뜨려서 사람이 보게 한다.
 *   - 저장·삭제는 잠금 방지 카운터를 초기화한다. 사람이 고쳤다는 뜻이므로 즉시 재시도.
 *
 * ## 폴백
 *
 * DB 행이 없으면 `.env`(SR_USERNAME/SR_PASSWORD)를 쓴다. 기존 설치가 그대로 돌고,
 * 화면에서 한 번 저장하는 순간부터 DB 가 이긴다.
 *
 * server-only 를 붙이지 않는다 — 수집기(Node)에서도 부른다.
 */
import { CREDENTIALS, DEFAULT_TEAM_ID } from "./config.ts";
import { isoNow } from "./dates.ts";
import type { Db } from "./db.ts";
import { clearLoginGuard } from "./loginGuard.ts";
import { decryptSecret, encryptSecret } from "./secretBox.ts";

/** 자격이 어디서 왔는가. */
export type CredentialSource = "db" | "env" | "none";

/** 내부 전용. 평문 비밀번호가 담긴다 — 화면·HTTP 응답에 실어 보내면 안 된다. */
export interface PortalCredentials {
  readonly username: string;
  readonly password: string;
  readonly source: Exclude<CredentialSource, "none">;
}

/** 화면용. 비밀번호는 담기지 않는다. */
export interface PortalCredentialsMeta {
  readonly username: string;
  readonly hasPassword: boolean;
  readonly source: CredentialSource;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

interface CredentialRow {
  username: string;
  password_enc: string;
  updated_at: string;
  updated_by: string;
}

export class CredentialsUnreadableError extends Error {
  constructor(detail: string) {
    super(
      "저장된 포털 비밀번호를 복호화할 수 없습니다. SR_SECRET_KEY 가 저장할 때와 다른 것 같습니다.\n" +
        "  설정 화면(/settings/account)에서 비밀번호를 다시 저장하세요.\n" +
        `  (${detail})`,
    );
    this.name = "CredentialsUnreadableError";
  }
}

async function loadRow(db: Db, teamId: string): Promise<CredentialRow | null> {
  const row = await db.get<CredentialRow>(
    "SELECT username, password_enc, updated_at, updated_by FROM portal_credentials WHERE team_id = ?",
    [teamId],
  );
  return row ?? null;
}

/** DB 행이 실제로 쓸 수 있는가. 아이디와 암호문이 **둘 다** 있어야 한다. */
function usable(row: CredentialRow | null): boolean {
  return row !== null && row.username.trim() !== "" && row.password_enc !== "";
}

/**
 * 로그인에 쓸 자격. 없으면 null.
 *
 * DB 가 .env 를 이긴다. 둘 다 없으면 null 이고, 부르는 쪽이 "계정이 없다" 로 처리한다.
 */
export async function getPortalCredentials(
  db: Db,
  teamId: string = DEFAULT_TEAM_ID,
): Promise<PortalCredentials | null> {
  const row = await loadRow(db, teamId);
  if (usable(row) && row !== null) {
    let password: string;
    try {
      password = decryptSecret(row.password_enc);
    } catch (error) {
      throw new CredentialsUnreadableError(error instanceof Error ? error.message : String(error));
    }
    return { username: row.username.trim(), password, source: "db" };
  }
  if (CREDENTIALS === null) return null;
  return { username: CREDENTIALS.username, password: CREDENTIALS.password, source: "env" };
}

/** 화면용 요약. 비밀번호는 절대 담지 않는다. */
export async function getPortalCredentialsMeta(
  db: Db,
  teamId: string = DEFAULT_TEAM_ID,
): Promise<PortalCredentialsMeta> {
  const row = await loadRow(db, teamId);
  if (usable(row) && row !== null) {
    return {
      username: row.username.trim(),
      hasPassword: true,
      source: "db",
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  }
  if (CREDENTIALS !== null) {
    return {
      username: CREDENTIALS.username,
      hasPassword: true,
      source: "env",
      updatedAt: "",
      updatedBy: "",
    };
  }
  // 아이디만 적혀 있고 비밀번호가 없는 어중간한 행도 여기로 온다(아이디는 보여 준다).
  return {
    username: row?.username.trim() ?? "",
    hasPassword: false,
    source: "none",
    updatedAt: row?.updated_at ?? "",
    updatedBy: row?.updated_by ?? "",
  };
}

export interface SaveCredentialsInput {
  readonly username: string;
  /** 비우면 기존 비밀번호를 유지한다. 기존이 없으면 거부한다. */
  readonly password: string;
  readonly actor?: string;
  readonly teamId?: string;
}

/**
 * 자격을 저장한다. 비밀번호를 비워 보내면 기존 값을 유지한다(아이디만 고치는 경우).
 *
 * 저장에 성공하면 잠금 방지 카운터를 초기화한다 — 사람이 새 값을 넣었으므로 즉시 다시
 * 시도해야 한다. 이게 차단에서 빠져나오는 정상 경로다.
 */
export async function savePortalCredentials(db: Db, input: SaveCredentialsInput): Promise<void> {
  const teamId = input.teamId ?? DEFAULT_TEAM_ID;
  const username = input.username.trim();
  if (username === "") throw new Error("아이디를 입력하세요.");

  const prev = await loadRow(db, teamId);
  // 비밀번호는 trim 하지 않는다 — 앞뒤 공백도 비밀번호의 일부일 수 있다(.env 경로와 같다).
  let passwordEnc: string;
  if (input.password !== "") {
    passwordEnc = encryptSecret(input.password);
  } else if (prev !== null && prev.password_enc !== "") {
    passwordEnc = prev.password_enc;
  } else {
    throw new Error("비밀번호를 입력하세요.");
  }

  await writeCredentials(db, { teamId, username, passwordEnc, actor: input.actor ?? "" });
}

/**
 * 암호문을 그대로 받아 저장한다.
 *
 * 로그인 화면의 「자동 로그인에 쓰기」가 쓴다. 그 흐름은 OTP 입력을 기다리는 동안
 * 비밀번호를 들고 있어야 하는데, **평문을 메모리에 쥐고 있지 않으려고** 받은 즉시
 * 암호화해 두고 성공한 뒤 이 함수로 넘긴다(lib/loginFlow.ts).
 */
export async function savePortalCredentialsEncrypted(
  db: Db,
  input: { teamId?: string; username: string; passwordEnc: string; actor?: string },
): Promise<void> {
  const username = input.username.trim();
  if (username === "" || input.passwordEnc === "") throw new Error("저장할 자격이 비었습니다.");
  await writeCredentials(db, {
    teamId: input.teamId ?? DEFAULT_TEAM_ID,
    username,
    passwordEnc: input.passwordEnc,
    actor: input.actor ?? "",
  });
}

async function writeCredentials(
  db: Db,
  input: { teamId: string; username: string; passwordEnc: string; actor: string },
): Promise<void> {
  const { teamId, username, passwordEnc } = input;
  await db.run(
    `INSERT INTO portal_credentials (team_id, username, password_enc, updated_at, updated_by)
     VALUES (?,?,?,?,?)
     ON CONFLICT(team_id) DO UPDATE SET
       username     = excluded.username,
       password_enc = excluded.password_enc,
       updated_at   = excluded.updated_at,
       updated_by   = excluded.updated_by`,
    [teamId, username, passwordEnc, isoNow(), input.actor.trim()],
  );

  // 아이디도 라벨로 맞춰 둔다(teams.broadcom_username 은 식별용 라벨이다).
  await db.run("UPDATE teams SET broadcom_username = ? WHERE team_id = ?", [username, teamId]);

  await clearLoginGuard(db, teamId, "새 자격 저장");
}

/** DB 자격을 지운다. 이후에는 .env 폴백으로 돌아간다. */
export async function deletePortalCredentials(
  db: Db,
  teamId: string = DEFAULT_TEAM_ID,
): Promise<void> {
  await db.run("DELETE FROM portal_credentials WHERE team_id = ?", [teamId]);
  await clearLoginGuard(db, teamId, "저장된 자격 삭제(.env 로 복귀)");
}
