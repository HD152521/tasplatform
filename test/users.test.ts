/**
 * 앱 사용자(신원)와 팀 소속.
 *
 * 이 시험이 지키는 네 가지:
 *   - **비밀번호 원문이 DB 에 없다.** 해시만 들어간다.
 *   - 아이디는 대소문자를 접는다 — 같은 사람이 둘로 갈리면 "누가 했는지" 가 흐려진다.
 *   - **첫 사용자만** 초대 코드 없이 들어온다(코드는 로그인해야 보이는 값이라,
 *     아무도 없을 때 요구하면 아무도 못 들어온다).
 *   - 아이디가 없는 로그인과 비밀번호가 틀린 로그인을 **구분해 알려주지 않는다.**
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertValidTeamId } from "../lib/config.ts";
import { getTeam, openDb, type Db } from "../lib/db.ts";
import {
  SignupError,
  addTeamMember,
  authenticate,
  countUsers,
  findTeamByInviteCode,
  generateInviteCode,
  getUserByLoginId,
  getUserWithTeam,
  hashPassword,
  listTeamMembers,
  normalizeLoginId,
  removeTeamMember,
  setDisplayName,
  setInviteCode,
  setJiraAccountId,
  setPassword,
  signup,
  verifyPassword,
} from "../lib/users.ts";

function freshDb(): Promise<Db> {
  return openDb(join(mkdtempSync(join(tmpdir(), "users-")), "sr.db"));
}

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

const FIRST = {
  loginId: "yongsik",
  displayName: "안용식",
  password: "hunter2hunter2",
  inviteCode: "",
};

/* ------------------------------------------------------------------ *
 * 비밀번호
 * ------------------------------------------------------------------ */

test("해시는 같은 비밀번호에도 매번 다르다 (소금)", async () => {
  const a = await hashPassword("same-password");
  const b = await hashPassword("same-password");
  assert.notEqual(a, b, "소금이 없으면 같은 비밀번호가 같은 해시가 된다");
  assert.ok(await verifyPassword("same-password", a));
  assert.ok(await verifyPassword("same-password", b));
});

test("틀린 비밀번호는 통과하지 않는다", async () => {
  const stored = await hashPassword("correct-horse");
  assert.equal(await verifyPassword("correct-horsE", stored), false);
  assert.equal(await verifyPassword("", stored), false);
});

test("해시 형식이 깨져 있으면 던지지 않고 false 다", async () => {
  // 던지면 깨진 행 하나가 로그인 화면 전체를 500 으로 만든다.
  for (const broken of ["", "x", "scrypt$1$2$3", "bcrypt$a$b$c$d$e", "scrypt$a$b$c$d$e"]) {
    assert.equal(await verifyPassword("anything", broken), false, `형식: ${JSON.stringify(broken)}`);
  }
});

test("해시 파라미터가 형식 안에 적혀 있다 — 나중에 비용을 올려도 옛 해시가 검증된다", async () => {
  const stored = await hashPassword("abcdefgh");
  const parts = stored.split("$");
  assert.equal(parts[0], "scrypt");
  assert.ok(Number(parts[1]) > 1, "N 이 숫자로 적혀 있어야 한다");
  assert.equal(parts.length, 6);
});

/* ------------------------------------------------------------------ *
 * 저장 — 원문은 어디에도 없다
 * ------------------------------------------------------------------ */

test("DB 에 비밀번호 원문이 없다", async () => {
  await signup(db, FIRST);
  const row = await db.get<Record<string, unknown>>("SELECT * FROM users WHERE login_id = ?", [
    "yongsik",
  ]);
  assert.ok(row !== undefined);
  const dumped = JSON.stringify(row);
  assert.ok(!dumped.includes(FIRST.password), "원문이 어느 칸에도 있으면 안 된다");
  assert.ok((row.password_hash as string).startsWith("scrypt$"));
});

/* ------------------------------------------------------------------ *
 * 아이디 정규화
 * ------------------------------------------------------------------ */

test("아이디는 소문자로 접힌다", async () => {
  assert.equal(normalizeLoginId("  YongSik  "), "yongsik");
  await signup(db, { ...FIRST, loginId: "YongSik" });
  assert.ok((await getUserByLoginId(db, "YONGSIK")) !== null, "대문자로도 같은 사람을 찾는다");
});

test("대소문자만 다른 아이디로 두 번 가입할 수 없다", async () => {
  await signup(db, FIRST);
  await setInviteCode(db, "default", "CODE1");
  await assert.rejects(
    () => signup(db, { loginId: "YONGSIK", displayName: "다른 사람", password: "abcdefgh", inviteCode: "CODE1" }),
    (error: unknown) => {
      assert.ok(error instanceof SignupError);
      assert.match(error.message, /이미 쓰고 있는/);
      return true;
    },
  );
});

test("쓸 수 없는 아이디·짧은 비밀번호는 거절한다", async () => {
  // "UPPER" 는 **쓸 수 있다** — 소문자로 접히기 때문이다. 그래서 목록에 없다.
  for (const bad of ["a", "안용식", "with space", "has/slash", ""]) {
    await assert.rejects(
      () => signup(db, { ...FIRST, loginId: bad }),
      SignupError,
      `아이디: ${JSON.stringify(bad)}`,
    );
  }
  await assert.rejects(() => signup(db, { ...FIRST, password: "short" }), SignupError);
  await assert.rejects(() => signup(db, { ...FIRST, displayName: "   " }), SignupError);
});

/* ------------------------------------------------------------------ *
 * 가입 — 첫 사람만 코드가 없어도 된다
 * ------------------------------------------------------------------ */

test("첫 사용자는 초대 코드 없이 기본 팀 owner 가 된다", async () => {
  assert.equal(await countUsers(db), 0);
  const user = await signup(db, FIRST);
  assert.equal(user.teamId, "default");
  assert.equal(user.role, "owner");
  assert.equal(await countUsers(db), 1);
});

test("두 번째 사용자는 코드가 없으면 거절된다", async () => {
  await signup(db, FIRST);
  await assert.rejects(
    () => signup(db, { loginId: "second", displayName: "둘째", password: "abcdefgh", inviteCode: "" }),
    (error: unknown) => {
      assert.ok(error instanceof SignupError);
      assert.match(error.message, /초대 코드가 필요/);
      return true;
    },
  );
  assert.equal(await countUsers(db), 1, "거절된 가입은 행을 남기지 않는다");
});

test("틀린 코드는 거절된다", async () => {
  await signup(db, FIRST);
  await setInviteCode(db, "default", "GOOD-CODE");
  await assert.rejects(
    () => signup(db, { loginId: "second", displayName: "둘째", password: "abcdefgh", inviteCode: "BAD" }),
    SignupError,
  );
});

test("맞는 코드로 가입하면 그 팀의 팀원이 된다", async () => {
  await signup(db, FIRST);
  await setInviteCode(db, "default", "GOOD-CODE");
  const second = await signup(db, {
    loginId: "second",
    displayName: "둘째",
    password: "abcdefgh",
    inviteCode: " good-CODE ".toUpperCase().trim(),
  });
  assert.equal(second.teamId, "default");
  assert.equal(second.role, "member", "초대로 들어온 사람은 owner 가 아니다");
});

test("코드를 지우면 가입이 닫힌다 — 빈 코드로는 아무 팀도 열리지 않는다", async () => {
  await signup(db, FIRST);
  await setInviteCode(db, "default", "");
  // invite_code 의 기본값이 빈 문자열이므로, 빈 코드를 허용하면 모든 팀이 열린다.
  assert.equal(await findTeamByInviteCode(db, ""), null);
  assert.equal(await findTeamByInviteCode(db, "   "), null);
  await assert.rejects(
    () => signup(db, { loginId: "second", displayName: "둘째", password: "abcdefgh", inviteCode: "" }),
    SignupError,
  );
});

test("생성한 초대 코드에는 혼동되는 글자가 없다", () => {
  for (let i = 0; i < 40; i += 1) {
    const code = generateInviteCode();
    assert.match(code, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/, code);
    assert.ok(!/[01OIL]/.test(code), `헷갈리는 글자가 들어갔다: ${code}`);
  }
});

/* ------------------------------------------------------------------ *
 * 로그인
 * ------------------------------------------------------------------ */

test("맞는 아이디·비밀번호면 사용자를 돌려준다", async () => {
  await signup(db, FIRST);
  const user = await authenticate(db, "YongSik", FIRST.password);
  assert.ok(user !== null);
  assert.equal(user.loginId, "yongsik");
});

test("없는 아이디와 틀린 비밀번호가 같은 답(null)이다", async () => {
  await signup(db, FIRST);
  assert.equal(await authenticate(db, "nobody", FIRST.password), null);
  assert.equal(await authenticate(db, "yongsik", "wrong-password"), null);
});

test("정지된 계정은 비밀번호가 맞아도 들어오지 못한다", async () => {
  const user = await signup(db, FIRST);
  await db.run("UPDATE users SET disabled = 1 WHERE user_id = ?", [user.userId]);
  assert.equal(await authenticate(db, "yongsik", FIRST.password), null);
});

test("비밀번호를 바꾸면 예전 비밀번호로는 못 들어온다", async () => {
  const user = await signup(db, FIRST);
  await setPassword(db, user.userId, "brand-new-pass");
  assert.equal(await authenticate(db, "yongsik", FIRST.password), null);
  assert.ok((await authenticate(db, "yongsik", "brand-new-pass")) !== null);
});

/* ------------------------------------------------------------------ *
 * 팀 소속
 * ------------------------------------------------------------------ */

test("팀원 목록은 들어온 순서대로다", async () => {
  await signup(db, FIRST);
  await setInviteCode(db, "default", "C1");
  await signup(db, { loginId: "second", displayName: "둘째", password: "abcdefgh", inviteCode: "C1" });

  const members = await listTeamMembers(db, "default");
  assert.deepEqual(members.map((m) => m.loginId), ["yongsik", "second"]);
  assert.deepEqual(members.map((m) => m.role), ["owner", "member"]);
});

test("팀에서 빼도 계정은 남는다 — 그 사람이 쓴 기록의 이름이 사라지면 안 된다", async () => {
  const user = await signup(db, FIRST);
  await removeTeamMember(db, "default", user.userId);

  assert.equal((await listTeamMembers(db, "default")).length, 0);
  const still = await getUserWithTeam(db, user.userId);
  assert.ok(still !== null, "계정은 남아야 한다");
  assert.equal(still.teamId, "", "팀 없음은 null 이 아니라 빈 팀 id 다");
});

test("역할 변경은 같은 행을 덮어쓴다(중복 행을 만들지 않는다)", async () => {
  const user = await signup(db, FIRST);
  await addTeamMember(db, "default", user.userId, "member");
  const members = await listTeamMembers(db, "default");
  assert.equal(members.length, 1);
  assert.equal(members[0]?.role, "member");
});

test("이름과 Jira 계정을 바꿀 수 있다", async () => {
  const user = await signup(db, FIRST);
  await setDisplayName(db, user.userId, "  새 이름  ");
  await setJiraAccountId(db, user.userId, "  5d1234abcd  ");

  const after = await getUserWithTeam(db, user.userId);
  assert.equal(after?.displayName, "새 이름");
  assert.equal(after?.jiraAccountId, "5d1234abcd", "공백은 떼고 저장한다");
});

/* ------------------------------------------------------------------ *
 * 새 팀 만들기 — 브로드컴 계정이 팀에 귀속되므로 팀이 먼저 있어야 한다
 * ------------------------------------------------------------------ */

test("가입할 때 새 팀을 만들고 그 팀의 owner 가 된다", async () => {
  await signup(db, FIRST);

  const made = await signup(db, {
    loginId: "second",
    displayName: "둘째",
    password: "abcdefgh",
    inviteCode: "",
    mode: "create",
    teamName: "데이터솔루션 2팀",
  });

  assert.notEqual(made.teamId, "default", "기본 팀에 끼어 들어가면 안 된다");
  assert.equal(made.role, "owner");
  assert.equal(made.teamName, "데이터솔루션 2팀");

  // 새 팀은 **가입이 닫힌 채로** 시작한다. owner 가 코드를 만들어야 사람이 들어온다.
  const team = await getTeam(db, made.teamId);
  assert.equal(team?.invite_code, "");
  assert.equal(team?.broadcom_username, "", "공용 계정은 아직 비어 있다");
});

test("새 팀 id 는 영숫자·하이픈뿐이다 — 경로로 쓰이기 때문이다", async () => {
  await signup(db, FIRST);
  const made = await signup(db, {
    loginId: "second", displayName: "둘째", password: "abcdefgh",
    inviteCode: "", mode: "create", teamName: "한글 이름 팀",
  });
  // 세션 파일 경로가 data/teams/<팀>/ 라서 한글·슬래시가 들어가면 안 된다.
  assert.match(made.teamId, /^[A-Za-z0-9_-]+$/);
  assert.doesNotThrow(() => assertValidTeamId(made.teamId));
});

test("새 팀 이름이 비면 거절한다", async () => {
  await signup(db, FIRST);
  await assert.rejects(
    () => signup(db, {
      loginId: "second", displayName: "둘째", password: "abcdefgh",
      inviteCode: "", mode: "create", teamName: "   ",
    }),
    /새 팀의 이름/,
  );
});

test("두 팀은 서로 다른 id 를 받는다", async () => {
  await signup(db, FIRST);
  const a = await signup(db, {
    loginId: "a2", displayName: "가", password: "abcdefgh",
    inviteCode: "", mode: "create", teamName: "같은 이름",
  });
  const b = await signup(db, {
    loginId: "b2", displayName: "나", password: "abcdefgh",
    inviteCode: "", mode: "create", teamName: "같은 이름",
  });
  assert.notEqual(a.teamId, b.teamId, "이름이 같아도 다른 팀이다");
});

test("첫 사용자도 새 팀을 만들 수 있다", async () => {
  const made = await signup(db, { ...FIRST, mode: "create", teamName: "처음부터 내 팀" });
  assert.notEqual(made.teamId, "default");
  assert.equal(made.role, "owner");
});
