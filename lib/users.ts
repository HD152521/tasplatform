/**
 * 앱 사용자(신원)와 팀 소속.
 *
 * ## 무엇을 위한 신원인가
 *
 * **방어가 아니라 귀속이다.** 이 도구는 사내망에서만 돌고, 바깥에서 누가 들어오는
 * 것은 지금 범위가 아니다. 그런데도 로그인을 넣는 이유는 세 가지다.
 *
 *   1. 감사 로그의 `actor` 가 지금 **빈 문자열**이다 — 화면이 보내는 값인데 아무도
 *      채우지 않는다. 공용 브로드컴 계정으로 고객에게 글을 쓰는 도구에서 "누가
 *      시켰는지" 가 비어 있는 것은 그 자체로 구멍이다.
 *   2. 캘린더·작업 기록은 "누가" 가 내용의 절반이다. 그 칸을 둘 곳이 필요하다.
 *   3. 팀이 둘 이상이 되면 "이 사람은 어느 팀 사람인가" 가 데이터 경계가 된다.
 *
 * ## 비밀번호
 *
 * `node:crypto` 의 **scrypt** 를 쓴다. bcrypt·argon2 는 새 의존성이고, 이 레포는
 * `node_modules` 를 통째로 드롭릿에 올리며 사내망에서 npm 레지스트리에 닿는지가
 * 불확실하다(.cfignore 가 node_modules 를 제외하지 않는 이유). 새 패키지를 늘리지
 * 않는다 — scrypt 는 표준 라이브러리에 있고 이 용도에 충분하다.
 *
 * 저장 형식: `scrypt$<N>$<r>$<p>$<salt-base64>$<hash-base64>`
 * 파라미터를 형식에 같이 적는다. 나중에 비용을 올려도 **옛 해시가 그대로 검증된다** —
 * 이걸 안 적어 두면 파라미터를 바꾸는 순간 전원이 로그인하지 못한다.
 *
 * 비교는 `timingSafeEqual` 로 한다. 길이가 다르면 그 함수가 던지므로 먼저 막는다.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { DEFAULT_TEAM_ID, assertValidTeamId } from "./config.ts";
import { isoNow } from "./dates.ts";
import type { Db } from "./db.ts";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

/** scrypt 비용. N=16384,r=8 → 약 16MB 메모리, 한 번에 수십 ms. 로그인 빈도에 맞는 값이다. */
const SCRYPT = { N: 16_384, r: 8, p: 1 } as const;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

/** 역할. owner 만 팀 설정(초대 코드·브로드컴 계정)을 바꿀 수 있다. */
export type TeamRole = "owner" | "member";

export interface AppUser {
  readonly userId: number;
  readonly loginId: string;
  readonly displayName: string;
  readonly jiraAccountId: string;
  readonly disabled: boolean;
  readonly createdAt: string;
  readonly lastLoginAt: string;
}

/** 사용자 + 그 사람이 지금 쓰는 팀. 화면과 API 가 이 묶음을 들고 다닌다. */
export interface UserWithTeam extends AppUser {
  readonly teamId: string;
  readonly teamName: string;
  readonly role: TeamRole;
}

export class SignupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignupError";
  }
}

/* ------------------------------------------------------------------ *
 * 비밀번호
 * ------------------------------------------------------------------ */

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, KEY_BYTES, SCRYPT);
  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

/**
 * 비밀번호 확인. 형식이 깨졌거나 해시가 비어 있으면 **false** 다 — 던지지 않는다.
 * 여기서 던지면 깨진 행 하나가 로그인 화면을 500 으로 만든다.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let expected: Buffer;
  try {
    expected = Buffer.from(parts[5] as string, "base64");
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  try {
    const actual = await scrypt(
      password,
      Buffer.from(parts[4] as string, "base64"),
      expected.length,
      { N, r, p },
    );
    // 길이가 같을 때만 비교한다 — timingSafeEqual 은 길이가 다르면 던진다.
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 입력 정규화
 * ------------------------------------------------------------------ */

/**
 * 로그인 아이디 정규화. **소문자로 접는다.**
 *
 * 이게 없으면 `Hong` 과 `hong` 이 서로 다른 사람이 되고, 같은 사람이 대문자로 한 번
 * 더 가입할 수 있다. 그 뒤에 등록한 일정이 둘로 갈려 "누가 했는지" 가 흐려진다.
 */
export function normalizeLoginId(raw: string): string {
  return raw.trim().toLowerCase();
}

const LOGIN_ID_PATTERN = /^[a-z0-9._@-]{2,64}$/;

export function assertLoginId(loginId: string): void {
  if (!LOGIN_ID_PATTERN.test(loginId)) {
    throw new SignupError(
      "아이디는 영문 소문자·숫자와 . _ - @ 만 쓸 수 있고 2~64자여야 합니다.",
    );
  }
}

/** 최소 길이만 본다. 복잡도 규칙은 두지 않는다 — 방어가 목적이 아니다(머리말). */
const MIN_PASSWORD = 8;

export function assertPassword(password: string): void {
  if (password.length < MIN_PASSWORD) {
    throw new SignupError(`비밀번호는 ${MIN_PASSWORD}자 이상이어야 합니다.`);
  }
}

/* ------------------------------------------------------------------ *
 * 조회
 * ------------------------------------------------------------------ */

interface UserRowRaw {
  user_id: number;
  login_id: string;
  display_name: string;
  password_hash: string;
  jira_account_id: string;
  created_at: string;
  last_login_at: string;
  disabled: number;
}

/** Postgres 는 BIGINT 를 문자열로 줄 수 있어 Number 로 접는다(lib/loginGuard.ts 와 같은 이유). */
function toUser(row: UserRowRaw): AppUser {
  return {
    userId: Number(row.user_id),
    loginId: row.login_id,
    displayName: row.display_name,
    jiraAccountId: row.jira_account_id,
    disabled: Number(row.disabled) === 1,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

export async function countUsers(db: Db): Promise<number> {
  const row = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users");
  return Number(row?.n ?? 0);
}

export async function getUserById(db: Db, userId: number): Promise<AppUser | null> {
  const row = await db.get<UserRowRaw>("SELECT * FROM users WHERE user_id = ?", [userId]);
  return row === undefined ? null : toUser(row);
}

export async function getUserByLoginId(db: Db, loginId: string): Promise<AppUser | null> {
  const row = await db.get<UserRowRaw>("SELECT * FROM users WHERE login_id = ?", [
    normalizeLoginId(loginId),
  ]);
  return row === undefined ? null : toUser(row);
}

/**
 * 없는 아이디로 들어왔을 때 돌릴 해시. 모양만 맞으면 되고 어떤 비밀번호와도 맞지 않는다
 * (salt·key 가 전부 0 이라 실제 scrypt 결과와 일치할 수 없다).
 */
const DUMMY_HASH = [
  "scrypt",
  SCRYPT.N,
  SCRYPT.r,
  SCRYPT.p,
  Buffer.alloc(SALT_BYTES).toString("base64"),
  Buffer.alloc(KEY_BYTES).toString("base64"),
].join("$");

/**
 * 아이디·비밀번호 확인. 맞으면 사용자, 아니면 **null**.
 *
 * "아이디가 없다" 와 "비밀번호가 틀렸다" 를 구분해 돌려주지 않는다. 사내망이라 해도
 * 둘을 갈라 주는 화면은 누가 등록돼 있는지 묻는 도구가 된다. 비용이 0 인 선택이다.
 *
 * 아이디가 없을 때도 **해시 비교를 한 번 돌린다**(더미 해시). 안 그러면 응답 시간으로
 * 아이디 존재 여부가 드러난다.
 */
export async function authenticate(
  db: Db,
  loginId: string,
  password: string,
): Promise<AppUser | null> {
  const row = await db.get<UserRowRaw>("SELECT * FROM users WHERE login_id = ?", [
    normalizeLoginId(loginId),
  ]);
  if (row === undefined) {
    await verifyPassword(password, DUMMY_HASH);
    return null;
  }
  if (!(await verifyPassword(password, row.password_hash))) return null;
  if (Number(row.disabled) === 1) return null;
  return toUser(row);
}

export async function touchLastLogin(db: Db, userId: number): Promise<void> {
  await db.run("UPDATE users SET last_login_at = ? WHERE user_id = ?", [isoNow(), userId]);
}

/* ------------------------------------------------------------------ *
 * 가입
 * ------------------------------------------------------------------ */

export interface SignupInput {
  readonly loginId: string;
  readonly displayName: string;
  readonly password: string;
  /** 팀 초대 코드. **첫 사용자**(사용자가 0명)일 때만 비워도 된다. */
  readonly inviteCode: string;
}

/**
 * 회원가입.
 *
 * ## 첫 사용자만 코드가 없어도 된다
 *
 * 초대 코드는 팀 설정 화면에서 보는 값이고, 그 화면은 로그인해야 열린다. 그러니
 * 아무도 없는 상태에서 코드를 요구하면 **누구도 들어올 수 없다**(닫힌 문 안에 열쇠).
 * 그래서 사용자가 0명이면 코드 없이 받고, 기본 팀의 **owner** 로 만든다.
 *
 * 두 사람이 동시에 "첫 사용자" 를 맞을 수 있다. 그래도 둘 다 owner 가 되는 것뿐이라
 * 해가 없다 — 데이터가 어긋나지는 않는다. 락을 걸지 않는다.
 */
export async function signup(db: Db, input: SignupInput): Promise<UserWithTeam> {
  const loginId = normalizeLoginId(input.loginId);
  assertLoginId(loginId);
  assertPassword(input.password);

  const displayName = input.displayName.trim();
  if (displayName === "") throw new SignupError("이름을 입력해 주세요.");

  if (await getUserByLoginId(db, loginId)) {
    throw new SignupError("이미 쓰고 있는 아이디입니다.");
  }

  const first = (await countUsers(db)) === 0;
  const code = input.inviteCode.trim();

  let teamId: string;
  let role: TeamRole;
  if (first) {
    teamId = DEFAULT_TEAM_ID;
    role = "owner";
  } else {
    if (code === "") throw new SignupError("팀 초대 코드가 필요합니다. 팀 관리자에게 받으세요.");
    const found = await findTeamByInviteCode(db, code);
    if (found === null) throw new SignupError("초대 코드가 맞지 않습니다.");
    teamId = found;
    role = "member";
  }

  const userId = await db.insertReturning(
    `INSERT INTO users (login_id, display_name, password_hash, jira_account_id,
                        created_at, last_login_at, disabled)
     VALUES (?,?,?,'',?,'',0)`,
    [loginId, displayName, await hashPassword(input.password), isoNow()],
    "user_id",
  );

  await addTeamMember(db, teamId, userId, role);
  const joined = await getUserWithTeam(db, userId);
  if (joined === null) throw new SignupError("가입 직후 사용자를 읽지 못했습니다.");
  return joined;
}

/**
 * 초대 코드로 팀을 찾는다. 코드가 비어 있으면 **찾지 않는다** —
 * `invite_code` 의 기본값이 빈 문자열이라, 빈 코드를 허용하면 코드를 설정하지 않은
 * 팀 전부가 빈 코드로 열린다.
 */
export async function findTeamByInviteCode(db: Db, code: string): Promise<string | null> {
  const trimmed = code.trim();
  if (trimmed === "") return null;
  const row = await db.get<{ team_id: string }>(
    "SELECT team_id FROM teams WHERE invite_code = ?",
    [trimmed],
  );
  return row === undefined ? null : row.team_id;
}

/** 초대 코드를 새로 넣는다(빈 값이면 가입을 닫는다). owner 만 부르는 경로에서 쓴다. */
export async function setInviteCode(db: Db, teamId: string, code: string): Promise<void> {
  assertValidTeamId(teamId);
  await db.run("UPDATE teams SET invite_code = ? WHERE team_id = ?", [code.trim(), teamId]);
}

/** 사람이 입에 올릴 수 있는 초대 코드. 혼동되는 글자(0/O, 1/I/l)를 뺀다. */
export function generateInviteCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(10);
  let out = "";
  for (let i = 0; i < 10; i += 1) {
    out += alphabet[(bytes[i] as number) % alphabet.length];
    if (i === 4) out += "-";
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 팀 소속
 * ------------------------------------------------------------------ */

export async function addTeamMember(
  db: Db,
  teamId: string,
  userId: number,
  role: TeamRole,
): Promise<void> {
  assertValidTeamId(teamId);
  await db.run(
    `INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?,?,?,?)
     ON CONFLICT(team_id, user_id) DO UPDATE SET role = excluded.role`,
    [teamId, userId, role, isoNow()],
  );
}

export async function removeTeamMember(db: Db, teamId: string, userId: number): Promise<void> {
  await db.run("DELETE FROM team_members WHERE team_id = ? AND user_id = ?", [teamId, userId]);
}

export interface TeamMember extends AppUser {
  readonly role: TeamRole;
  readonly joinedAt: string;
}

/** 그 팀의 사람들. 먼저 들어온 순서. */
export async function listTeamMembers(db: Db, teamId: string): Promise<TeamMember[]> {
  const rows = await db.all<UserRowRaw & { role: string; joined_at: string }>(
    `SELECT u.*, m.role AS role, m.joined_at AS joined_at
       FROM team_members m JOIN users u ON u.user_id = m.user_id
      WHERE m.team_id = ?
      ORDER BY m.joined_at ASC, u.user_id ASC`,
    [teamId],
  );
  return rows.map((row) => ({
    ...toUser(row),
    role: row.role === "owner" ? ("owner" as const) : ("member" as const),
    joinedAt: row.joined_at,
  }));
}

/**
 * 사용자 + 지금 쓰는 팀.
 *
 * 여러 팀에 속해 있으면 **먼저 들어간 팀**을 쓴다. 팀 전환 UI 는 두 번째 팀이
 * 실제로 생기는 시점(S2a)에 붙인다 — 지금 만들면 쓰지 않는 화면이 된다.
 *
 * 팀이 **없는** 사람도 null 이 아니다. 소속이 끊긴 것은 로그인 못 할 이유가 아니라
 * "관리자에게 연결을 요청해야 한다" 는 상태다. teamId 가 빈 문자열로 온다.
 */
export async function getUserWithTeam(db: Db, userId: number): Promise<UserWithTeam | null> {
  const user = await getUserById(db, userId);
  if (user === null) return null;

  const row = await db.get<{ team_id: string; role: string; team_name: string }>(
    `SELECT m.team_id AS team_id, m.role AS role, COALESCE(t.team_name, '') AS team_name
       FROM team_members m LEFT JOIN teams t ON t.team_id = m.team_id
      WHERE m.user_id = ?
      ORDER BY m.joined_at ASC, m.team_id ASC
      LIMIT 1`,
    [userId],
  );

  return {
    ...user,
    teamId: row?.team_id ?? "",
    teamName: row?.team_name ?? "",
    role: row?.role === "owner" ? "owner" : "member",
  };
}

export async function setJiraAccountId(
  db: Db,
  userId: number,
  accountId: string,
): Promise<void> {
  await db.run("UPDATE users SET jira_account_id = ? WHERE user_id = ?", [
    accountId.trim(),
    userId,
  ]);
}

export async function setDisplayName(db: Db, userId: number, name: string): Promise<void> {
  const trimmed = name.trim();
  if (trimmed === "") throw new SignupError("이름을 입력해 주세요.");
  await db.run("UPDATE users SET display_name = ? WHERE user_id = ?", [trimmed, userId]);
}

/** 비밀번호 변경. 지금 비밀번호를 확인하는 것은 **부르는 쪽**의 책임이다. */
export async function setPassword(db: Db, userId: number, password: string): Promise<void> {
  assertPassword(password);
  await db.run("UPDATE users SET password_hash = ? WHERE user_id = ?", [
    await hashPassword(password),
    userId,
  ]);
}
