/**
 * 브로드컴 공용 계정 설정 API — **팀에 귀속된다.**
 *
 * ## 왜 팀 단위인가
 *
 * 이 계정은 한 팀이 공유하는 포털 계정이다. 팀이 둘이면 계정도 둘이고, 세션·기기신뢰·
 * 잠금 상태도 각각이다. 저장 계층은 처음부터 그렇게 갈려 있었다
 * (`portal_credentials.team_id` 가 기본키, 세션 파일도 `data/teams/<팀>/`).
 *
 * 막혀 있던 곳은 **웹뿐**이었다 — 이 라우트가 `DEFAULT_TEAM_ID` 를 박아 써서, 어느
 * 팀 사람이 열어도 1번 팀 계정을 보고 고쳤다. 그래서 세션에서 팀을 읽는다.
 *
 * 비밀번호는 요청 본문으로만 들어오고, 암호화해서(AES-256-GCM) DB 에 넣는다. GET 은
 * 평문도 암호문도 돌려주지 않는다 — 아이디와 "있다/없다" 뿐이다.
 *
 * 감사 로그에도 비밀번호는 남기지 않는다(아이디만). 공용 계정이라 "언제 누가 돌렸나" 가
 * 조사의 출발점이라서 그 둘은 남긴다.
 */
import { NextResponse } from "next/server";
import { actorOf, userFromRequestWith, type UserWithTeam } from "../../../../lib/appAuth.ts";
import { openDb, recordAudit } from "../../../../lib/db.ts";
import type { Db } from "../../../../lib/dbCore.ts";
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
 * 로그인한 사람과 그 팀. 둘 중 하나라도 없으면 응답을 돌려준다.
 *
 * 팀이 없는 사람에게 **기본 팀을 보여 주지 않는다.** 그게 예전 동작이었고, 소속이
 * 끊긴 사람이 남의 팀 공용 계정을 고칠 수 있는 길이었다.
 */
async function requireTeam(
  db: Db,
  request: Request,
): Promise<{ me: UserWithTeam } | { fail: NextResponse }> {
  const me = await userFromRequestWith(db, request);
  if (me === null) {
    return { fail: NextResponse.json({ ok: false, message: "로그인이 필요합니다." }, { status: 401 }) };
  }
  if (me.teamId === "") {
    return {
      fail: NextResponse.json(
        { ok: false, message: "속한 팀이 없습니다. 팀 관리자에게 연결을 요청하세요." },
        { status: 400 },
      ),
    };
  }
  return { me };
}

/** 그 팀의 현재 계정(마스킹) + 자동 로그인 상태. */
export async function GET(request: Request) {
  const db = await openDb();
  try {
    const got = await requireTeam(db, request);
    if ("fail" in got) return got.fail;
    const { me } = got;

    return NextResponse.json({
      ok: true,
      teamId: me.teamId,
      teamName: me.teamName,
      credentials: await getPortalCredentialsMeta(db, me.teamId),
      guard: await readLoginGuard(db, me.teamId),
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

  const db = await openDb();
  try {
    const got = await requireTeam(db, request);
    if ("fail" in got) return got.fail;
    const { me } = got;
    const actor = actorOf(me);

    try {
      await savePortalCredentials(db, { username, password, actor, teamId: me.teamId });
      await recordAudit(db, {
        actor, teamId: me.teamId, action: "portal_credentials_upsert", requestId: null,
        result: "ok", detail: `user=${username.trim()}`,
      });
      return NextResponse.json({
        ok: true,
        credentials: await getPortalCredentialsMeta(db, me.teamId),
        guard: await readLoginGuard(db, me.teamId),
      });
    } catch (error) {
      const code = error instanceof MissingSecretKeyError ? "no_key" : "error";
      await recordAudit(db, {
        actor, teamId: me.teamId, action: "portal_credentials_upsert", requestId: null,
        result: `failed:${code}`, detail: `user=${username.trim()}`,
      }).catch(() => undefined);
      // 키가 없으면 저장 자체를 거부한다 — 평문으로 떨어지지 않는다.
      return NextResponse.json(
        { ok: false, message: errorMessage(error) },
        { status: error instanceof MissingSecretKeyError ? 503 : 400 },
      );
    }
  } catch (error) {
    return NextResponse.json({ ok: false, message: errorMessage(error) }, { status: 500 });
  } finally {
    await db.close();
  }
}

/** 저장된 계정 삭제. 이후에는 .env 폴백으로 돌아간다. */
export async function DELETE(request: Request) {
  const db = await openDb();
  try {
    const got = await requireTeam(db, request);
    if ("fail" in got) return got.fail;
    const { me } = got;

    await deletePortalCredentials(db, me.teamId);
    await recordAudit(db, {
      actor: actorOf(me), teamId: me.teamId, action: "portal_credentials_delete", requestId: null,
      result: "ok", detail: "",
    });
    return NextResponse.json({
      ok: true,
      credentials: await getPortalCredentialsMeta(db, me.teamId),
      guard: await readLoginGuard(db, me.teamId),
    });
  } catch (error) {
    return NextResponse.json({ ok: false, message: errorMessage(error) }, { status: 500 });
  } finally {
    await db.close();
  }
}
