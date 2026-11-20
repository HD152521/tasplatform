/**
 * 자동 로그인 잠금 방지.
 *
 * ## 무엇을 막는가
 *
 * 수집기는 세션이 만료되면 저장된 계정으로 **스스로** 재로그인한다
 * (collector/collect.ts acquireBrowserSession). 그 회차는 15분마다 돈다. 비밀번호가
 * 바뀌었는데 우리 쪽 값이 옛것이면, **한 시간에 네 번씩 틀린 비밀번호를 IdP 에 보낸다.**
 * 공용 계정이 잠기고, 그러면 수집·조회·첨부가 통째로 멈춘다. 사람이 알아차리는 건
 * 보통 잠긴 다음이다.
 *
 * ## 규칙
 *
 *   성공            → 초기화
 *   OTP 필요        → 초기화. **비밀번호는 통과했다**는 신호다
 *   거절            → +1
 *   그 외 실패      → 비밀번호를 제출한 시도만 +1 (입력칸을 못 찾은 회차는 IdP 와 무관)
 *   잠김·만료       → 즉시 중단. 더 찔러도 의미가 없고 잠금만 길어진다
 *
 * 한도(기본 2)에 닿으면 **멈추고, 저절로 다시 시작하지 않는다.**
 *
 * ## 왜 시간이 지나도 안 풀리나
 *
 * 쿨다운을 둬서 몇 시간 뒤 혼자 다시 시도하게 만들 수도 있다. 하지만 비밀번호가 틀린
 * 상태는 시간이 지나도 그대로다 — 혼자 찔러 보면 IdP 의 실패 카운터만 한 칸 더 올라가고,
 * 그게 반복되면 결국 잠긴다. 고칠 수 있는 것은 사람뿐이다. 그래서 사람이 손을 쓸 때까지
 * 가만히 있는다. 멈춘 사실은 알림(웹훅)과 설정 화면으로 알린다.
 *
 * ## 어떻게 풀리나 (전부 사람의 동작이다)
 *
 *   - 설정 화면에서 **새 비밀번호 저장** → 완전 초기화(한도 2회)
 *   - 로그인 화면에서 **직접 로그인 성공** → 완전 초기화
 *   - 「비밀번호 그대로 지금 다시 시도」 → **한 번만** 더 시도한다(한 번 더 실패하면 즉시 중단).
 *     값을 안 바꾼 채 버튼만 누르는 것으로 실패 횟수가 쌓이지 않게 하려는 것이다.
 */
import { DEFAULT_TEAM_ID } from "./config.ts";
import { isoNow } from "./dates.ts";
import type { Db } from "./db.ts";
import { NEEDS_HUMAN, type AttemptFacts, type LoginOutcome } from "./loginOutcome.ts";

/**
 * 환경변수에서 양수를 읽는다.
 *
 * `Number("")` 은 0 이다. 빈 문자열을 그냥 Number 에 넘기면 "설정 안 함" 이 "0" 으로
 * 바뀌어 한도가 0(= 첫 실패에 중단)이 된다. 비어 있는지를 먼저 본다.
 */
function positiveFromEnv(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 멈추기까지 허용하는 연속 실패 횟수. */
export const failLimit = (): number => positiveFromEnv("SR_LOGIN_FAIL_LIMIT", 2);

export interface LoginGuardState {
  readonly failCount: number;
  /** 자동 시도 중단 상태인가. 사람이 풀어야 한다. */
  readonly blocked: boolean;
  /** 언제 멈췄나(ISO). 중단 상태가 아니면 빈 문자열. */
  readonly blockedAt: string;
  readonly lastAttemptAt: string;
  readonly lastResult: LoginOutcome | "";
  readonly lastReason: string;
  /** 사람이 포털에서 직접 손봐야 풀리는 상태인가(잠김·만료). */
  readonly needsHuman: boolean;
  /** 중단까지 남은 실패 횟수. 이미 중단이면 0. */
  readonly remaining: number;
}

interface GuardRow {
  fail_count: number;
  blocked: number;
  blocked_at: string;
  last_attempt_at: string;
  last_result: string;
  last_reason: string;
}

const EMPTY: GuardRow = {
  fail_count: 0,
  blocked: 0,
  blocked_at: "",
  last_attempt_at: "",
  last_result: "",
  last_reason: "",
};

export class LoginBlockedError extends Error {
  readonly state: LoginGuardState;
  constructor(message: string, state: LoginGuardState) {
    super(message);
    this.name = "LoginBlockedError";
    this.state = state;
  }
}

function toState(row: GuardRow): LoginGuardState {
  const blocked = row.blocked !== 0;
  const result = row.last_result as LoginOutcome | "";
  return {
    failCount: row.fail_count,
    blocked,
    blockedAt: blocked ? row.blocked_at : "",
    lastAttemptAt: row.last_attempt_at,
    lastResult: result,
    lastReason: row.last_reason,
    needsHuman: blocked && result !== "" && NEEDS_HUMAN.has(result),
    remaining: blocked ? 0 : Math.max(0, failLimit() - row.fail_count),
  };
}

async function loadRow(db: Db, teamId: string): Promise<GuardRow> {
  const row = await db.get<GuardRow>(
    `SELECT fail_count, blocked, blocked_at, last_attempt_at, last_result, last_reason
       FROM portal_login_guard WHERE team_id = ?`,
    [teamId],
  );
  // Postgres 는 BIGINT 를 문자열로 줄 수 있다. 숫자로 맞춰 둔다.
  return row === undefined ? EMPTY : { ...row, fail_count: Number(row.fail_count), blocked: Number(row.blocked) };
}

async function writeRow(db: Db, teamId: string, row: GuardRow): Promise<void> {
  await db.run(
    `INSERT INTO portal_login_guard
       (team_id, fail_count, blocked, blocked_at, last_attempt_at, last_result, last_reason, updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(team_id) DO UPDATE SET
       fail_count      = excluded.fail_count,
       blocked         = excluded.blocked,
       blocked_at      = excluded.blocked_at,
       last_attempt_at = excluded.last_attempt_at,
       last_result     = excluded.last_result,
       last_reason     = excluded.last_reason,
       updated_at      = excluded.updated_at`,
    [
      teamId,
      row.fail_count,
      row.blocked,
      row.blocked_at,
      row.last_attempt_at,
      row.last_result,
      row.last_reason,
      isoNow(),
    ],
  );
}

export async function readLoginGuard(
  db: Db,
  teamId: string = DEFAULT_TEAM_ID,
): Promise<LoginGuardState> {
  return toState(await loadRow(db, teamId));
}

/**
 * 지금 자동 로그인을 해도 되는지. 안 되면 던진다.
 *
 * **브라우저를 띄우기 전에** 부른다. 중단 상태인데 브라우저를 띄우면 그 자체로 1~2분과
 * 메모리를 쓰고, 최악은 로그인 화면까지 가서 비밀번호를 또 넣는 것이다.
 */
export async function assertAutoLoginAllowed(
  db: Db,
  teamId: string = DEFAULT_TEAM_ID,
): Promise<LoginGuardState> {
  const state = await readLoginGuard(db, teamId);
  if (!state.blocked) return state;

  const head = state.needsHuman
    ? state.lastResult === "locked"
      ? "계정이 잠긴 것으로 보여 자동 로그인을 멈췄습니다."
      : "비밀번호가 만료된 것으로 보여 자동 로그인을 멈췄습니다."
    : `로그인이 연속 ${failLimit()}번 실패해 계정 잠금을 막기 위해 자동 로그인을 멈췄습니다.`;

  throw new LoginBlockedError(
    `${head}\n` +
      `  마지막 사유: ${state.lastReason || "(없음)"}\n` +
      `  **시간이 지나도 저절로 재시도하지 않습니다.** 사람이 다음 중 하나를 해야 풀립니다:\n` +
      `   - 설정 화면(/settings/account)에 새 비밀번호 저장\n` +
      `   - 로그인 화면(/login)에서 직접 로그인\n` +
      `   - 설정 화면의 「비밀번호 그대로 지금 다시 시도」`,
    state,
  );
}

/**
 * 시도 결과를 기록한다. 바뀐 상태를 돌려준다.
 *
 * 성공·OTP 는 초기화, 거절은 가산, 잠김·만료는 즉시 중단이다. 자세한 규칙은 머리말.
 */
export async function recordLoginAttempt(
  db: Db,
  facts: AttemptFacts,
  teamId: string = DEFAULT_TEAM_ID,
): Promise<LoginGuardState> {
  const prev = await loadRow(db, teamId);
  const stamp = isoNow();

  // 비밀번호가 통과한 두 경우는 깨끗이 지운다.
  if (facts.outcome === "ok" || facts.outcome === "otp") {
    const row: GuardRow = {
      fail_count: 0,
      blocked: 0,
      blocked_at: "",
      last_attempt_at: stamp,
      last_result: facts.outcome,
      last_reason: facts.outcome === "otp" ? facts.reason : "",
    };
    await writeRow(db, teamId, row);
    return toState(row);
  }

  // 잠김·만료: 더 시도해도 의미가 없다. 한 번에 멈춘다.
  if (NEEDS_HUMAN.has(facts.outcome)) {
    const row: GuardRow = {
      fail_count: prev.fail_count + 1,
      blocked: 1,
      blocked_at: stamp,
      last_attempt_at: stamp,
      last_result: facts.outcome,
      last_reason: facts.reason,
    };
    await writeRow(db, teamId, row);
    return toState(row);
  }

  // 비밀번호를 넣지 않은 실패는 세지 않는다 — IdP 의 실패 횟수와 무관하다.
  // (거절은 비밀번호 칸 전에 아이디가 거절된 경우도 있어 따로 통과시킨다.)
  const counts = facts.outcome === "rejected" || facts.passwordSubmitted;
  const failCount = counts ? prev.fail_count + 1 : prev.fail_count;
  const hit = counts && failCount >= failLimit();

  const row: GuardRow = {
    fail_count: failCount,
    blocked: hit || prev.blocked !== 0 ? 1 : 0,
    blocked_at: hit && prev.blocked === 0 ? stamp : prev.blocked_at,
    last_attempt_at: stamp,
    last_result: facts.outcome,
    last_reason: facts.reason,
  };
  await writeRow(db, teamId, row);
  return toState(row);
}

/**
 * 사람이 손을 썼다 — 중단을 푼다.
 *
 * `attempts` 가 요점이다.
 *
 *   "full" 새 비밀번호를 저장했거나 사람이 직접 로그인에 성공한 경우. 처음부터 센다.
 *   "one"  값은 그대로인데 「지금 다시 시도」를 누른 경우. **한 번만** 시도하고, 그
 *          한 번이 실패하면 즉시 다시 멈춘다. 버튼만 반복해서 눌러도 IdP 의 실패
 *          횟수가 쌓이지 않게 하는 장치다.
 */
export async function clearLoginGuard(
  db: Db,
  teamId: string = DEFAULT_TEAM_ID,
  why = "사람이 초기화",
  attempts: "full" | "one" = "full",
): Promise<void> {
  // 마지막 시도의 기록(시각·결과)은 지우지 않는다. 중단만 푼다 — 화면에서 "직전에
  // 무엇 때문에 막혔었나" 를 계속 보여줘야 사람이 제대로 고쳤는지 판단할 수 있다.
  const prev = await loadRow(db, teamId);
  await writeRow(db, teamId, {
    ...prev,
    fail_count: attempts === "one" ? Math.max(0, failLimit() - 1) : 0,
    blocked: 0,
    blocked_at: "",
    last_reason: why,
  });
}
