/**
 * 쓰기 경로(답변/작성)의 actor/team 처리 + 감사 로그 연결.
 *
 * server-only 를 붙이지 않는다 — node:test 로 직접 단위테스트하기 위해서다.
 * 라우트가 실제로 브로드컴에 쓰는 lib/reply.ts·lib/createCase.ts 는 server-only 라
 * node --test 에서 못 불러온다(실측 확인). 그래서 그 두 라우트가 공통으로 쓰는
 * "actor/team 뽑기"와 "감사 로그 남기기"만 이 파일로 분리해 여기서 테스트한다.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_TEAM_ID, assertValidTeamId, sessionFileForTeam } from "./config.ts";
import { openDb, recordAudit } from "./db.ts";
import type { AuditEntry } from "./db.ts";
import { hydrateTeamSessionFromDb } from "./sessionStore.ts";
import { getSessionStatus } from "./sessionFile.ts";

export type ActorTeamResult =
  | { ok: true; actor: string; teamId: string }
  | { ok: false; message: string };

/**
 * 로그인한 사람에서 뽑아 낸 신원. 라우트가 세션에서 읽어 넘긴다.
 *
 * 이 모듈은 `next/headers` 를 쓰지 않는다(수집기·테스트에서도 불린다). 그래서
 * 세션을 **읽지 않고 받는다** — 읽는 쪽은 라우트(lib/appAuth.ts)다.
 */
export interface SessionIdentity {
  readonly actor: string;
  readonly teamId: string;
}

/**
 * 요청 바디에서 actor(요청 사용자 식별자)와 team(대상 팀)을 뽑는다.
 *
 * 하위호환 필수: 지금 SR 뷰어 화면은 이 필드 없이 호출한다.
 * team 이 없거나 빈 문자열이면 기본 팀(DEFAULT_TEAM_ID), actor 가 없으면 빈 문자열로
 * 처리해서 기존 화면 호출이 그대로 동작해야 한다.
 *
 * team 형식이 잘못되면(assertValidTeamId 실패) ok:false 로 이유를 돌려준다.
 * 호출부(라우트)가 이를 400 응답으로 옮긴다.
 */
export function resolveActorTeam(
  body: { actor?: unknown; team?: unknown },
  session?: SessionIdentity | null,
): ActorTeamResult {
  // 로그인한 사람이 있으면 **그 사람이 actor 다.** 본문의 actor 는 무시한다 —
  // 그 칸은 호출자가 적어 보내는 값이라 "누가 시켰는지" 의 근거가 되지 못한다
  // (실제로 화면은 늘 빈 문자열을 보내 왔다). 세션이 없는 호출(MCP·수집기·챗봇)은
  // 예전처럼 본문 값을 쓴다 — 그쪽은 팀 토큰으로 이미 신원이 확인된 경로다.
  const actor =
    session != null && session.actor !== ""
      ? session.actor
      : typeof body.actor === "string"
        ? body.actor.trim()
        : "";
  const teamRaw =
    session != null && session.teamId !== ""
      ? session.teamId
      : typeof body.team === "string"
        ? body.team.trim()
        : "";
  const teamId = teamRaw === "" ? DEFAULT_TEAM_ID : teamRaw;

  try {
    assertValidTeamId(teamId);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, actor, teamId };
}

/**
 * 쓰기 실행(성공/실패) 뒤 감사 로그 한 줄을 남긴다.
 *
 * DB open/close 를 감싼다. recordAudit 자체가 내부에서 예외를 삼키지만,
 * openDb 가 실패하는 극단적인 경우까지 방어해서 감사 로그 실패가 본 응답을
 * 막지 않게 한다(요구사항: 로그 실패가 본 작업을 막지 않을 것).
 *
 * dbFile 은 테스트에서 임시 DB 를 쓰기 위한 것이다. 실제 라우트는 생략해서
 * 기본 DB(DB_FILE)를 쓴다.
 */
export async function recordWriteAudit(entry: AuditEntry, dbFile?: string): Promise<void> {
  let db;
  try {
    db = await openDb(dbFile);
  } catch (error) {
    console.error("[audit] DB 를 열지 못해 감사 로그를 남기지 못했습니다", error);
    return;
  }
  try {
    await recordAudit(db, entry);
  } finally {
    await db.close();
  }
}

/**
 * 그 팀이 **쓸 수 있는** 세션을 가지고 있는지 확인한다.
 *
 * 쓰기(답변/작성/첨부) 시도 **전에** 불러서, 세션이 없으면 브로드컴에 요청조차 보내지
 * 않고 바로 401 을 돌려주기 위한 것이다. reply·create 두 라우트가 대칭으로
 * 이 함수를 쓴다. (덤으로 Step 4 MCP 의 "세션 없으면 로그인 유도" 요구도
 * 여기서 같이 충족된다.)
 *
 * ## 파일이 있는 것만으로는 모자랐다
 *
 * 전에는 `existsSync` 한 줄이었다. 그래서 **한 달 넘게 만료된 세션도 이 문턱을
 * 통과했다** — 첨부를 올리면 큐에 멀쩡히 들어가고, 수십 초 뒤 수집기에서 실패했다.
 * 사람은 그 긴 시간을 기다린 끝에 영문 모를 사유만 봤다(실측: 로컬 세션이 35일 전
 * 만료된 상태로 남아 있었다).
 *
 * **만료 시각을 읽을 수 있고, 그 시각이 지났을 때만** 막는다. 못 읽는 경우는
 * 통과시킨다 — sspsession 이 세션 쿠키(만료 음수)로 저장되는 모양이 있고, 그걸
 * 만료로 보면 정상인 세션에서 쓰기가 전부 멈춘다. 여기서는 **조금 늦게 막는 쪽이
 * 틀리게 막는 쪽보다 낫다**(틀리게 막으면 도구를 아예 못 쓴다).
 */
export function hasTeamSession(teamId: string): boolean {
  if (!existsSync(resolve(sessionFileForTeam(teamId)))) return false;
  const { expiresAt } = getSessionStatus(teamId);
  return expiresAt === null || expiresAt > Date.now();
}

/**
 * 쓰기 자체가 이미 성공한 "뒤"의 부수효과(세션 쿠키 저장·목록/스레드 새로고침)를
 * 실행한다. 실패해도 예외를 삼켜 이미 확정된 성공 응답·감사 로그를 흔들지 않는다
 * — persist 는 쿠키 저장일 뿐이고, refresh 는 다음 정기 수집이 어차피 채운다.
 * console.error 로만 남긴다.
 *
 * reply·create 라우트가 postReply/createCase 가 ok:true 를 반환한 뒤에만 부른다.
 */
export async function runSideEffect(label: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  await sideEffectValue(label, async () => { await fn(); }, undefined);
}

/**
 * 값을 돌려주는 부수효과. 터지면 fallback 이다.
 *
 * 화면에 **무엇을 말할지**가 부수효과 결과에 달린 경우에 쓴다. 방금 쓴 글이 포털
 * 조회에 실제로 잡혔는지(lib/refreshCase.ts 의 reflect\*)가 그렇다 — 안내 문구가
 * 갈린다. runSideEffect 처럼 삼키면 그걸 알 수 없어 늘 "다음 수집 때" 라고만 말한다.
 *
 * 실패를 응답으로 뒤집지 않는 규칙은 같다. 쓰기는 이미 끝났고, 되돌릴 수 없다.
 */
export async function sideEffectValue<T>(
  label: string,
  fn: () => T | Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    console.error(`[audit] 부수효과 실패 (쓰기 자체는 이미 성공): ${label}`, error);
    return fallback;
  }
}

/**
 * 쓰기·읽기 전에 세션을 확보한다. 못 하면 돌려줄 응답을, 됐으면 null.
 *
 * 다섯 라우트가 이 세 줄을 각자 복사해 갖고 있었다.
 *
 *     await hydrateTeamSessionFromDb(teamId);
 *     if (!hasTeamSession(teamId)) return 401 ...;
 *
 * 지금은 문구와 순서가 같지만, 한 곳만 hydrate 를 빼먹거나 메시지를 고치면 그
 * 라우트만 조용히 어긋난다. 실제로 답변 라우트의 catch 블록이 그렇게 갈라져,
 * 망 오류까지 "세션이 만료되었습니다" 로 보이던 적이 있다.
 *
 * audit 을 주면 실패를 감사 로그에 남긴다. 읽기 경로(첨부·본문 이미지)는 남기지 않는다 —
 * 조회는 기록할 일이 아니고, 남기면 로그가 조회로 덮인다.
 */
export async function ensureTeamSession(
  teamId: string,
  audit?: { actor: string; action: string; requestId: number | null },
): Promise<Response | null> {
  // 재시작으로 로컬 파일이 없을 수 있다. DB 백업에서 먼저 복원한다.
  await hydrateTeamSessionFromDb(teamId);
  if (hasTeamSession(teamId)) return null;

  if (audit !== undefined) {
    await recordWriteAudit({
      actor: audit.actor,
      teamId,
      action: audit.action,
      requestId: audit.requestId,
      result: "failed:session",
    });
  }
  // 없는 것과 **만료된 것**은 사람이 할 일이 같지만(로그인), 보고 받는 말은 달라야
  // 한다 — "없습니다" 는 처음 쓰는 사람의 문장이고, 쓰던 사람은 "어제까지 됐는데" 를
  // 먼저 의심한다. 만료 시각까지 말해 주면 그 자리에서 납득한다.
  // (mcp/writeTools.ts 에 같은 뜻의 짧은 문장이 따로 있다. 그쪽은 주입된 판정만 쓴다.)
  return Response.json(
    { ok: false, code: "session", message: sessionFailureMessage(teamId) },
    { status: 401 },
  );
}

/**
 * 세션 문턱에서 막혔을 때 보여줄 말. 없음 / 만료를 가른다.
 *
 * **"SR 페이지에서 로그인하세요" 라고 말하지 않는다.** 웹에서는 로그인할 수 없다 —
 * 컨테이너에 브라우저가 없다(SR_DISABLE_BROWSER_LOGIN). 세션을 되살리는 것은 수집기이고,
 * 그 요청은 왼쪽 아래 세션 표시가 내준다(app/SessionDot.tsx). 할 일을 그쪽으로 보낸다.
 */
function sessionFailureMessage(teamId: string): string {
  const { exists, expiresAt } = getSessionStatus(teamId);
  const todo = "왼쪽 아래 세션 표시에서 「수집기에 재로그인 요청」을 눌러 주세요.";
  if (!exists || expiresAt === null) {
    return `세션이 없습니다. ${todo}`;
  }
  const hours = (Date.now() - expiresAt) / 3_600_000;
  const ago = hours < 48 ? `${Math.round(hours)}시간 전` : `${Math.round(hours / 24)}일 전`;
  return `세션이 ${ago}에 만료되었습니다. ${todo}`;
}
