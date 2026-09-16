import { NextResponse } from "next/server";
import { DEFAULT_TEAM_ID, assertValidTeamId } from "../../../lib/config.ts";
import { listTeams, openDb, recordAudit } from "../../../lib/db.ts";
import { MissingSecretKeyError } from "../../../lib/secretBox.ts";
import {
  assertValidBaseUrl,
  assertValidKind,
  deleteIntegration,
  listIntegrations,
  upsertIntegration,
} from "../../../lib/teamIntegration.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 요청 사용자 식별자(선택). 이 라우트는 아직 앱 인증이 없으므로(별도 정책 항목) 안 보내면
 * 빈 문자열로 남긴다 — 지금 여기서 인증을 추가하지 않는다.
 */
function readActor(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 팀의 연동 목록(마스킹) + 선택 가능한 팀 목록.
 * 토큰 평문·암호문은 listIntegrations 자체가 담지 않으므로 여기서도 노출되지 않는다.
 */
export async function GET(request: Request) {
  const teamId = new URL(request.url).searchParams.get("team")?.trim() || DEFAULT_TEAM_ID;
  try {
    assertValidTeamId(teamId);
  } catch (error) {
    return NextResponse.json({ ok: false, message: errorMessage(error) }, { status: 400 });
  }

  const db = openDb();
  try {
    return NextResponse.json({
      ok: true,
      teamId,
      teams: listTeams(db),
      integrations: listIntegrations(db, teamId),
    });
  } catch (error) {
    return NextResponse.json({ ok: false, message: errorMessage(error) }, { status: 500 });
  } finally {
    db.close();
  }
}

/**
 * 등록/수정. secret 을 비워 보내면 기존 토큰을 유지한다(upsertIntegration 관례).
 *
 * 자격(토큰) 등록·수정은 보안 민감 동작이라 감사 로그를 남긴다(recordAudit). detail 에는
 * kind 만 남기고 base_url·secret 등 값은 절대 넣지 않는다 — recordAudit 자체가 내부에서
 * 예외를 삼키므로 로그 실패가 이 응답을 막지 않는다.
 */
export async function POST(request: Request) {
  let body: {
    team?: unknown; kind?: unknown; baseUrl?: unknown; project?: unknown; secret?: unknown;
    actor?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: "잘못된 요청입니다." }, { status: 400 });
  }

  const teamId = typeof body.team === "string" ? body.team.trim() : "";
  const kind = typeof body.kind === "string" ? body.kind.trim() : "";
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
  const project = typeof body.project === "string" ? body.project.trim() : "";
  const secret = typeof body.secret === "string" ? body.secret : "";
  const actor = readActor(body.actor);

  if (teamId === "" || kind === "" || baseUrl === "" || project === "") {
    return NextResponse.json(
      { ok: false, message: "team, kind, baseUrl, project 는 필수입니다." },
      { status: 400 },
    );
  }

  try {
    assertValidTeamId(teamId);
    assertValidKind(kind);
    assertValidBaseUrl(baseUrl);
  } catch (error) {
    return NextResponse.json({ ok: false, message: errorMessage(error) }, { status: 400 });
  }

  const db = openDb();
  try {
    upsertIntegration(db, { teamId, kind, baseUrl, project, secret });
    recordAudit(db, {
      actor, teamId, action: "integration_upsert", requestId: null,
      result: "ok", detail: `kind=${kind}`,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const code = error instanceof MissingSecretKeyError ? "no_key" : "error";
    recordAudit(db, {
      actor, teamId, action: "integration_upsert", requestId: null,
      result: `failed:${code}`, detail: `kind=${kind}`,
    });
    if (error instanceof MissingSecretKeyError) {
      // 키가 없어 암호화를 못 해 저장을 거부한 것 — 설정 오류이지 사용자 입력 오류가 아니므로 503.
      return NextResponse.json({ ok: false, message: error.message }, { status: 503 });
    }
    console.error("[api/settings] 저장 실패", error);
    return NextResponse.json({ ok: false, message: errorMessage(error) }, { status: 400 });
  } finally {
    db.close();
  }
}

/**
 * 삭제. team·kind 는 쿼리스트링으로 받는다(GET 과 대칭). actor 도 선택적으로 쿼리스트링에서 받는다.
 * 등록·수정과 같은 이유로 삭제도 감사 로그를 남긴다 — detail 에는 kind 만 남긴다.
 */
export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const teamId = url.searchParams.get("team")?.trim() ?? "";
  const kind = url.searchParams.get("kind")?.trim() ?? "";
  const actor = readActor(url.searchParams.get("actor"));

  if (teamId === "" || kind === "") {
    return NextResponse.json({ ok: false, message: "team, kind 는 필수입니다." }, { status: 400 });
  }
  try {
    assertValidTeamId(teamId);
  } catch (error) {
    return NextResponse.json({ ok: false, message: errorMessage(error) }, { status: 400 });
  }

  const db = openDb();
  try {
    deleteIntegration(db, teamId, kind);
    recordAudit(db, {
      actor, teamId, action: "integration_delete", requestId: null,
      result: "ok", detail: `kind=${kind}`,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    recordAudit(db, {
      actor, teamId, action: "integration_delete", requestId: null,
      result: "failed:error", detail: `kind=${kind}`,
    });
    return NextResponse.json({ ok: false, message: errorMessage(error) }, { status: 500 });
  } finally {
    db.close();
  }
}
