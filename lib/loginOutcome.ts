/**
 * 로그인 시도의 **결과를 판정**한다.
 *
 * 왜 따로 떼어 두는가. 2026-11 까지 자동 로그인은 "되거나 / 안 되거나" 두 가지만
 * 구분했다. 비밀번호가 틀려도 코드가 알아보지 못해 90초를 기다린 뒤
 * `"로그인 후 세션이 발급되지 않았습니다 (타임아웃)"` 으로 끝났고, 15분 뒤 **같은 틀린
 * 비밀번호로 또 시도했다.** 공용 계정이 잠기는 건 시간 문제였다.
 *
 * 잠금을 막으려면 세 가지를 갈라야 한다.
 *
 *   - **거절**(rejected)  비밀번호가 틀렸다. 다시 보내면 IdP 의 실패 횟수만 올라간다.
 *   - **OTP 필요**(otp)   비밀번호는 **통과했다.** 실패로 세면 안 된다.
 *   - **그 외 실패**(failed) 망·화면 구조·타임아웃. 계정과 무관할 수 있다.
 *
 * 여기에 두 가지를 더 본다. 둘 다 "더 시도해도 의미가 없고, 사람이 손을 써야 하는" 상태다.
 *
 *   - **잠김**(locked)   이미 잠겼다. 더 찔러서 잠금 시간을 늘리지 않는다.
 *   - **만료**(expired)  비밀번호 자체가 만료돼 변경이 필요하다. 회전 주기가 있는
 *                        공용 계정에서 실제로 마주치는 상태다.
 *
 * 판정은 **화면 글자**로 한다. 브라우저가 없어도 되는 순수 함수(classifyLoginText)로
 * 두어 테스트가 실제 문구를 그대로 넣어 잠근다.
 */

/** 시도 한 번의 결과. 잠금 방지 카운터(lib/loginGuard.ts)가 이걸로 판단한다. */
export type LoginOutcome = "ok" | "otp" | "rejected" | "locked" | "expired" | "failed";

/** 사람이 손을 써야 하는 결과 — 쿨다운이 끝나도 자동 재시도로는 풀리지 않는다. */
export const NEEDS_HUMAN: ReadonlySet<LoginOutcome> = new Set<LoginOutcome>(["locked", "expired"]);

export interface LoginRejection {
  readonly kind: "locked" | "expired" | "rejected";
  /** IdP 가 실제로 띄운 문장(잘라서). 추측 대신 근거를 남긴다. */
  readonly hint: string;
}

const HINT_MAX = 160;

/**
 * 화면 문구 패턴.
 *
 * 순서가 의미를 가진다 — 위에서부터 본다. 잠김·만료를 먼저 보는 이유는 그 화면에도
 * "sign in failed" 같은 일반 문구가 **같이** 뜨는 일이 있어서다. 일반 거절로 접으면
 * 잠긴 계정을 계속 찔러 잠금을 연장한다.
 *
 * 문구는 IdP(access.broadcom.com) 가 언제든 바꿀 수 있다. 못 알아보면 'failed' 로
 * 떨어지는데, 그쪽도 (비밀번호를 제출한 시도라면) 카운터에 들어가므로 무한 재시도는
 * 되지 않는다 — 알아보면 2번에 멈추고, 못 알아봐도 멈추기는 한다.
 */
const PATTERNS: ReadonlyArray<readonly [LoginRejection["kind"], RegExp]> = [
  // --- 잠김 ---
  ["locked", /\baccount\b[^.\n]{0,40}\block(ed|out)\b/i],
  ["locked", /\block(ed)?\s*out\b/i],
  ["locked", /\btemporarily\s+(locked|disabled|suspended)\b/i],
  ["locked", /too many (failed|unsuccessful|invalid)/i],
  ["locked", /exceeded[^.\n]{0,40}(attempts|tries)/i],
  ["locked", /계정[^.\n]{0,20}(잠금|잠겼)/],
  // --- 만료(변경 필요) ---
  ["expired", /password[^.\n]{0,30}\bexpired\b/i],
  ["expired", /\bexpired\b[^.\n]{0,20}password/i],
  ["expired", /must (change|reset|update) your password/i],
  ["expired", /비밀번호[^.\n]{0,20}만료/],
  // --- 일반 거절 ---
  ["rejected", /invalid\s+(user\s?name|username|user id|login|credential|password)/i],
  ["rejected", /(user\s?name|username|password)[^.\n]{0,30}\b(incorrect|invalid|not\s+(correct|valid))\b/i],
  ["rejected", /\bincorrect\s+(user\s?name|username|password)\b/i],
  ["rejected", /(sign|log)\s?-?\s?in\s+failed/i],
  ["rejected", /unable to (sign|log)\s?-?\s?in/i],
  ["rejected", /authentication\s+(failed|error)/i],
  ["rejected", /(아이디|비밀번호)[^.\n]{0,20}(틀렸|맞지 않|올바르지)/],
];

function trim(line: string): string {
  const picked = line.trim().replace(/\s+/g, " ");
  return picked.length > HINT_MAX ? `${picked.slice(0, HINT_MAX)}…` : picked;
}

/**
 * **조건절은 버린다.** 로그인 화면에는 안내문이 같이 붙어 있다.
 *
 *   "If your account is locked, contact your administrator."
 *   "Your password will expire in 7 days."
 *
 * 이런 줄을 그대로 보면 멀쩡한 로그인 화면을 "잠김" 으로 읽고 24시간 쉬어 버린다.
 * 지금 벌어진 일을 말하는 줄만 남긴다.
 */
const ADVISORY = [
  /\b(if|when|should|unless)\b/i,
  /\bwill\s+(expire|be\s+locked)\b/i,
  /\bmay\s+be\b/i,
  /(하면|되면|경우)/,
] as const;
// ⚠ "contact your administrator" 를 안내문 표식으로 쓰지 않는다. **진짜 잠김 메시지가
//   그 문장을 함께 달고 나온다**("Your account has been locked. Contact your
//   administrator."). 그걸 버리면 정작 잠김을 못 알아본다. 구분선은 조건절과 미래형이다.

function isAdvisory(line: string): boolean {
  return ADVISORY.some((pattern) => pattern.test(line));
}

/**
 * 로그인 화면 글자에서 거절 사유를 읽는다. 해당 없으면 null.
 *
 * **비밀번호를 제출한 뒤에만** 부른다. 로그인 위젯이 오류 칸을 미리 그려 두는 경우가
 * 있어서다(그래서 부르는 쪽은 textContent 가 아니라 innerText 를 넘긴다 — innerText 는
 * 눌러 둔(hidden) 요소를 빼고 읽는다).
 *
 * 줄 단위로 본다. 한 줄에서 잠김·만료·거절 중 하나가 걸리면 그 줄을 근거로 남긴다.
 * 패턴 순서(잠김 → 만료 → 거절)를 **줄 순서보다 우선**한다 — 한 화면에 "sign in failed"
 * 와 "account is locked" 가 같이 떠도 잠김으로 읽어야 더 찔러서 잠금을 늘리지 않는다.
 */
export function classifyLoginText(text: string): LoginRejection | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !isAdvisory(line));
  if (lines.length === 0) return null;

  for (const [kind, pattern] of PATTERNS) {
    const hit = lines.find((line) => pattern.test(line));
    if (hit !== undefined) return { kind, hint: trim(hit) };
  }
  return null;
}

/**
 * OTP 를 요구받아 무인 로그인을 더 진행할 수 없는 상태.
 *
 * **실패가 아니다.** 비밀번호는 통과했다는 신호다(lib/loginGuard.ts 가 카운터를 되돌린다).
 */
export class OtpRequiredError extends Error {
  constructor() {
    super(
      "OTP 인증이 필요합니다. 자동 로그인으로는 진행할 수 없습니다.\n" +
        "  'npm run login' 을 직접 실행해 브라우저에서 OTP를 입력하세요.",
    );
    this.name = "OtpRequiredError";
  }
}

/**
 * 로그인 시도가 실패했다. **비밀번호를 제출했는지**를 함께 들고 다닌다.
 *
 * 그 한 비트가 잠금 방지의 핵심이다. 입력칸을 못 찾아 끝난 회차는 IdP 의 실패 카운터에
 * 아무 영향이 없으므로 세면 안 되고(세면 멀쩡한 계정이 망 문제로 차단된다), 비밀번호를
 * 넣고 거절당한 회차는 반드시 세야 한다.
 */
export class LoginAttemptError extends Error {
  readonly outcome: Extract<LoginOutcome, "rejected" | "locked" | "expired" | "failed">;
  readonly passwordSubmitted: boolean;
  /** IdP 가 띄운 문장(있으면). */
  readonly hint: string;

  constructor(
    outcome: LoginAttemptError["outcome"],
    message: string,
    options: { passwordSubmitted: boolean; hint?: string },
  ) {
    super(message);
    this.name = "LoginAttemptError";
    this.outcome = outcome;
    this.passwordSubmitted = options.passwordSubmitted;
    this.hint = options.hint ?? "";
  }
}

export interface AttemptFacts {
  readonly outcome: LoginOutcome;
  readonly reason: string;
  readonly passwordSubmitted: boolean;
}

/** 거절 종류별 사람 말. 화면과 로그에 같은 문장이 나가게 한 곳에 둔다. */
export function rejectionMessage(rejection: LoginRejection): string {
  const tail = rejection.hint === "" ? "" : ` (화면: ${rejection.hint})`;
  if (rejection.kind === "locked") {
    return `계정이 잠긴 것으로 보입니다. 더 시도하면 잠금만 길어지므로 중단합니다.${tail}`;
  }
  if (rejection.kind === "expired") {
    return `비밀번호가 만료되어 변경이 필요합니다. 포털에서 새 비밀번호로 바꾼 뒤 저장하세요.${tail}`;
  }
  return `아이디 또는 비밀번호가 맞지 않습니다.${tail}`;
}

/**
 * 던져진 오류를 카운터가 먹을 수 있는 사실로 바꾼다.
 *
 * 모르는 오류는 `failed` + `passwordSubmitted: false` 로 둔다 — 알 수 없는 것을
 * 비밀번호 실패로 세지 않는다(세면 망 장애가 계정 차단으로 번진다).
 */
export function outcomeOf(error: unknown): AttemptFacts {
  if (error instanceof OtpRequiredError) {
    return { outcome: "otp", reason: "OTP 필요(비밀번호는 통과)", passwordSubmitted: true };
  }
  if (error instanceof LoginAttemptError) {
    return {
      outcome: error.outcome,
      reason: error.message,
      passwordSubmitted: error.passwordSubmitted,
    };
  }
  return {
    outcome: "failed",
    reason: error instanceof Error ? error.message : String(error),
    passwordSubmitted: false,
  };
}
