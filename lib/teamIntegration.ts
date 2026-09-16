/**
 * 팀 단위 외부 연동(Jira 등) 자격 CRUD.
 *
 * kind 는 연동 종류 식별자("jira" 등) — team_integrations 테이블은 앞으로 다른 연동도
 * 같은 틀로 담기 위해 kind 로 구분해 둔다.
 *
 * 민감값(토큰)은 secretBox 로 암호화해 저장한다. listIntegrations(화면용)는 평문·암호문을
 * 절대 반환하지 않고 존재 여부(boolean)만 돌려준다 — getIntegration(내부/리졸버용)만
 * 복호화한 값을 돌려주며, 이 결과를 화면·API 응답에 그대로 실어 보내면 안 된다.
 *
 * lib/atlassian.ts 의 기존 env 기반 Jira 설정(ATLASSIAN_BASE 등)은 이 모듈과 무관하게
 * 그대로 동작한다 — 여기서는 건드리지 않는다.
 */
import { assertValidTeamId } from "./config.ts";
import { isoNow } from "./dates.ts";
import { getTeam, type Db } from "./db.ts";
import { decryptSecret, encryptSecret } from "./secretBox.ts";

const KIND_PATTERN = /^[a-z0-9_]+$/;

/** kind 형식. 소문자·숫자·언더스코어만 허용한다(SQL 값일 뿐이지만 오타·형식오류를 일찍 잡는다). */
export function assertValidKind(kind: string): void {
  if (!KIND_PATTERN.test(kind)) {
    throw new Error(`잘못된 연동 종류입니다: ${JSON.stringify(kind)} (소문자·숫자·언더스코어만 허용)`);
  }
}

/**
 * https 만 허용한다. 사내망이라도 토큰이 실려 나갈 base_url 을 평문 http 로 두지 않기 위해서다.
 * 형식 검증까지만 한다 — 실제로 그 주소에 연결해보는 것은 이 단계의 범위 밖이다.
 */
export function assertValidBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`base_url 형식이 올바르지 않습니다: ${JSON.stringify(baseUrl)}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error("base_url 은 https 여야 합니다.");
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

export interface UpsertIntegrationInput {
  teamId: string;
  kind: string;
  baseUrl: string;
  project: string;
  /** 빈 문자열이면 "이 필드는 바꾸지 않음"(기존 토큰 유지)으로 처리한다. */
  secret?: string;
}

/**
 * 등록/수정.
 *
 * - teamId 형식 검증 + 팀 존재 확인(issueTeamToken 과 같은 원칙: 없는 팀으로는 등록하지 않는다).
 * - kind/base_url/project 최소 검증.
 * - secret 이 비어 있으면(수정 시 토큰을 다시 입력하지 않은 경우) 기존 암호문을 그대로 둔다.
 * - secret 이 채워져 있는데 SR_SECRET_KEY 가 없으면 encryptSecret 이 던지고, 그 예외가 그대로
 *   올라간다 — INSERT 문 실행 전이므로 행이 부분적으로도 남지 않는다(평문 저장 폴백 금지).
 */
export async function upsertIntegration(db: Db, input: UpsertIntegrationInput): Promise<void> {
  assertValidTeamId(input.teamId);
  const team = await getTeam(db, input.teamId);
  if (!team) {
    throw new Error(`연동을 등록할 팀이 존재하지 않습니다: ${input.teamId}`);
  }
  assertValidKind(input.kind);

  const baseUrl = normalizeBaseUrl(input.baseUrl);
  assertValidBaseUrl(baseUrl);

  const project = input.project.trim();
  if (project === "") {
    throw new Error("project 값이 필요합니다.");
  }

  const secretInput = (input.secret ?? "").trim();
  // 빈 문자열을 그대로 바인딩하면 ON CONFLICT 쪽 CASE 식이 "값 유지"로 해석한다.
  const secretEnc = secretInput === "" ? "" : encryptSecret(secretInput);

  await db.run(
    `INSERT INTO team_integrations (team_id, kind, base_url, project, secret_enc, updated_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(team_id, kind) DO UPDATE SET
       base_url   = excluded.base_url,
       project    = excluded.project,
       secret_enc = CASE WHEN excluded.secret_enc = '' THEN team_integrations.secret_enc ELSE excluded.secret_enc END,
       updated_at = excluded.updated_at`,
    [input.teamId, input.kind, baseUrl, project, secretEnc, isoNow()],
  );
}

interface IntegrationRowRaw {
  team_id: string;
  kind: string;
  base_url: string;
  project: string;
  secret_enc: string;
  updated_at: string;
}

export interface TeamIntegration {
  teamId: string;
  kind: string;
  baseUrl: string;
  project: string;
  /** 복호화된 평문. 내부(리졸버) 전용 — 화면·API 응답에 그대로 실어 보내지 말 것. */
  secret: string;
  updatedAt: string;
}

/**
 * 내부용. 복호화된 평문 토큰을 돌려준다.
 * 화면/HTTP 응답에는 절대 그대로 노출하지 말 것 — Jira 호출 같은 서버 내부 리졸버 전용이다.
 */
export async function getIntegration(
  db: Db,
  teamId: string,
  kind: string,
): Promise<TeamIntegration | null> {
  assertValidTeamId(teamId);
  const row = await db.get<IntegrationRowRaw>(
    "SELECT * FROM team_integrations WHERE team_id = ? AND kind = ?",
    [teamId, kind],
  );
  if (!row) return null;

  return {
    teamId: row.team_id,
    kind: row.kind,
    baseUrl: row.base_url,
    project: row.project,
    secret: row.secret_enc === "" ? "" : decryptSecret(row.secret_enc),
    updatedAt: row.updated_at,
  };
}

export interface TeamIntegrationMeta {
  teamId: string;
  kind: string;
  baseUrl: string;
  project: string;
  /** 토큰이 등록돼 있는지 여부만. 평문·암호문 어느 것도 이 타입에 담기지 않는다. */
  hasSecret: boolean;
  updatedAt: string;
}

/** 화면용 목록. 복호화하지 않는다 — 반환값에 평문·암호문이 전혀 담기지 않는다. */
export async function listIntegrations(db: Db, teamId: string): Promise<TeamIntegrationMeta[]> {
  assertValidTeamId(teamId);
  const rows = await db.all<IntegrationRowRaw>(
    `SELECT team_id, kind, base_url, project, secret_enc, updated_at
     FROM team_integrations WHERE team_id = ? ORDER BY kind`,
    [teamId],
  );

  return rows.map((row) => ({
    teamId: row.team_id,
    kind: row.kind,
    baseUrl: row.base_url,
    project: row.project,
    hasSecret: row.secret_enc !== "",
    updatedAt: row.updated_at,
  }));
}

/** 삭제. 존재하지 않아도 조용히 반환한다(teamToken.ts revoke 와 같은 관례). */
export async function deleteIntegration(db: Db, teamId: string, kind: string): Promise<void> {
  assertValidTeamId(teamId);
  await db.run("DELETE FROM team_integrations WHERE team_id = ? AND kind = ?", [teamId, kind]);
}
