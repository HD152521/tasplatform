/**
 * 브로드컴 공용 계정 설정 API.
 *
 * 비밀번호는 요청 본문으로만 들어오고, 암호화해서(AES-256-GCM) DB 에 넣는다. GET 은
 * 평문도 암호문도 돌려주지 않는다 — 아이디와 "있다/없다" 뿐이다.
 *
 * 감사 로그에도 비밀번호는 남기지 않는다(아이디만). 공용 계정이라 "언제 누가 돌렸나" 가
 * 조사의 출발점이라서 그 둘은 남긴다.
 */
import { NextResponse } from "next/server";
import { actorOf, userFromRequest } from "../../../../lib/appAuth.ts";
import { DEFAULT_TEAM_ID } from "../../../../lib/config.ts";
import { openDb, recordAudit } from "../../../../lib/db.ts";
import { hasSecretKey, MissingSecretKeyError } from "../../../../lib/secretBox.ts";
import {
  deletePortalCredentials,
  getPortalCredentialsMeta,
  savePortalCredentials,
} from "../../../../lib/portalCredentials.ts";
import { failLimit, readLoginGuard } from "../../../../lib/loginGuard.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 감사 로그의 actor.
 *
 * **세션이 있으면 그 사람이다.** 본문/쿼리의 actor 는 호출자가 적어 보내는 값이고,
 * 화면은 그 칸을 비워 보내 왔다 — 공용 계정 비밀번호를 바꾼 기록에 사람 이름이
 * 없었다는 뜻이다. 세션이 없을 때만 예전처럼 받은 값을 쓴다(스크립트 호출 호환).
 */
async function resolveActor(request: Request, fallback: unknown): Promise<string> {
  const user = await userFromRequest(request).catch(() => null);
  if (user !== null) return actorOf(user);
  return typeof fallback === "string" ? fallback.trim() : "";
}

/** 현재 계정(마스킹) + 자동 로그인 상태. */
export async function GET() {
  const db = await openDb();
  try {
    return NextResponse.json({
      ok: true,
      credentials: await getPortalCredentialsMeta(db),
      guard: await readLoginGuard(db),
      failLimit: failLimit(),
      hasSecretKey: hasSecretKey(),
    });
  } catch (error) {
    return NextResponse.json({ ok: false, message: errorMessage(error) }, { status: 500 });
  } finally {
    await db.close();
  }
}

/** 저장. 비밀번호를 비워 보내면 기존 값을 유지한다(아이디만 고치는 경우). */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, message: "잘못된 요청입니다." }, { status: 400 });
  }

  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  const actor = await resolveActor(request, body.actor);

  const db = await openDb();
  try {
    await savePortalCredentials(db, { username, password, actor });
    await recordAudit(db, {
      actor, teamId: DEFAULT_TEAM_ID, action: "portal_credentials_upsert", requestId: null,
      result: "ok", detail: `user=${username.trim()}`,
    });
    return NextResponse.json({
      ok: true,
      credentials: await getPortalCredentialsMeta(db),
      guard: await readLoginGuard(db),
    });
  } catch (error) {
    const code = error instanceof MissingSecretKeyError ? "no_key" : "error";
    await recordAudit(db, {
      actor, teamId: DEFAULT_TEAM_ID, action: "portal_credentials_upsert", requestId: null,
      result: `failed:${code}`, detail: `user=${username.trim()}`,
    }).catch(() => undefined);
    // 키가 없으면 저장 자체를 거부한다 — 평문으로 떨어지지 않는다.
    return NextResponse.json(
      { ok: false, message: errorMessage(error) },
      { status: error instanceof MissingSecretKeyError ? 503 : 400 },
    );
  } finally {
    await db.close();
  }
}

/** 저장된 계정 삭제. 이후에는 .env 폴백으로 돌아간다. */
export async function DELETE(request: Request) {
  const actor = await resolveActor(request, new URL(request.url).searchParams.get("actor"));
  const db = await openDb();
  try {
    await deletePortalCredentials(db);
    await recordAudit(db, {
      actor, teamId: DEFAULT_TEAM_ID, action: "portal_credentials_delete", requestId: null,
      result: "ok", detail: "",
    });
    return NextResponse.json({
      ok: true,
      credentials: await getPortalCredentialsMeta(db),
      guard: await readLoginGuard(db),
    });
  } catch (error) {
    return NextResponse.json({ ok: false, message: errorMessage(error) }, { status: 500 });
  } finally {
    await db.close();
  }
}
