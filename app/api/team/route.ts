/**
 * 팀 관리 — 초대 코드, 팀 이름, 팀원 역할.
 *
 * 전부 **owner 만** 할 수 있다. 화면에서 버튼을 숨기는 것으로 끝내지 않고 여기서
 * 다시 본다 — 화면은 사람이 보는 것이고, 이 주소는 누구나 부를 수 있다.
 */
import { NextResponse } from "next/server";
import { userFromRequestWith } from "../../../lib/appAuth.ts";
import { getTeam, openDb, recordAudit, upsertTeam } from "../../../lib/db.ts";
import {
  generateInviteCode,
  listTeamMembers,
  removeTeamMember,
  setInviteCode,
  addTeamMember,
} from "../../../lib/users.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UNAUTHORIZED = { ok: false, message: "로그인이 필요합니다." };
const FORBIDDEN = { ok: false, message: "팀 관리자(owner)만 할 수 있습니다." };

export async function GET(request: Request) {
  const db = await openDb();
  try {
    const me = await userFromRequestWith(db, request);
    if (me === null) return NextResponse.json(UNAUTHORIZED, { status: 401 });
    if (me.teamId === "") {
      return NextResponse.json({ ok: true, team: null, members: [], me: shapeMe(me) });
    }

    const team = await getTeam(db, me.teamId);
    const members = await listTeamMembers(db, me.teamId);
    return NextResponse.json({
      ok: true,
      team: {
        teamId: me.teamId,
        teamName: team?.team_name ?? "",
        broadcomUsername: team?.broadcom_username ?? "",
        // 초대 코드는 **owner 에게만** 내려 준다. 가입을 열고 닫는 열쇠다.
        inviteCode: me.role === "owner" ? (team?.invite_code ?? "") : "",
      },
      members: members.map((m) => ({
        userId: m.userId,
        loginId: m.loginId,
        displayName: m.displayName,
        role: m.role,
        joinedAt: m.joinedAt,
        hasJira: m.jiraAccountId !== "",
        lastLoginAt: m.lastLoginAt,
      })),
      me: shapeMe(me),
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  } finally {
    await db.close();
  }
}

function shapeMe(me: { userId: number; loginId: string; displayName: string; role: string; jiraAccountId: string }) {
  return {
    userId: me.userId,
    loginId: me.loginId,
    displayName: me.displayName,
    role: me.role,
    jiraAccountId: me.jiraAccountId,
  };
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, message: "요청 본문을 읽지 못했습니다." }, { status: 400 });
  }
  const action = typeof body.action === "string" ? body.action : "";

  const db = await openDb();
  try {
    const me = await userFromRequestWith(db, request);
    if (me === null) return NextResponse.json(UNAUTHORIZED, { status: 401 });
    if (me.teamId === "") {
      return NextResponse.json({ ok: false, message: "속한 팀이 없습니다." }, { status: 400 });
    }
    if (me.role !== "owner") return NextResponse.json(FORBIDDEN, { status: 403 });

    const actor = `${me.displayName}(${me.loginId})`;

    switch (action) {
      case "invite_new": {
        const code = generateInviteCode();
        await setInviteCode(db, me.teamId, code);
        await recordAudit(db, {
          actor, teamId: me.teamId, action: "team_invite_new", requestId: null,
          // 코드 자체는 남기지 않는다 — 감사 로그는 여러 사람이 본다.
          result: "ok", detail: "",
        });
        return NextResponse.json({ ok: true, inviteCode: code });
      }

      case "invite_clear": {
        await setInviteCode(db, me.teamId, "");
        await recordAudit(db, {
          actor, teamId: me.teamId, action: "team_invite_clear", requestId: null,
          result: "ok", detail: "",
        });
        return NextResponse.json({ ok: true, inviteCode: "" });
      }

      case "team_name": {
        const name = typeof body.teamName === "string" ? body.teamName.trim() : "";
        if (name === "") {
          return NextResponse.json({ ok: false, message: "팀 이름을 입력해 주세요." }, { status: 400 });
        }
        const team = await getTeam(db, me.teamId);
        await upsertTeam(db, {
          team_id: me.teamId,
          team_name: name,
          broadcom_username: team?.broadcom_username ?? "",
        });
        await recordAudit(db, {
          actor, teamId: me.teamId, action: "team_rename", requestId: null,
          result: "ok", detail: `name=${name}`,
        });
        return NextResponse.json({ ok: true, teamName: name });
      }

      case "set_role": {
        const userId = Number(body.userId);
        const role = body.role === "owner" ? "owner" : "member";
        if (!Number.isInteger(userId)) {
          return NextResponse.json({ ok: false, message: "대상이 올바르지 않습니다." }, { status: 400 });
        }
        // **마지막 owner 를 member 로 내리지 못한다.** 그러면 팀 설정을 아무도 바꿀
        // 수 없고, 초대 코드도 못 만들어 새 사람을 받을 길이 사라진다.
        if (role === "member" && (await countOwners(db, me.teamId)) <= 1) {
          return NextResponse.json(
            { ok: false, message: "마지막 관리자는 내릴 수 없습니다. 먼저 다른 사람을 관리자로 올리세요." },
            { status: 400 },
          );
        }
        await addTeamMember(db, me.teamId, userId, role);
        await recordAudit(db, {
          actor, teamId: me.teamId, action: "team_set_role", requestId: null,
          result: "ok", detail: `user=${userId} role=${role}`,
        });
        return NextResponse.json({ ok: true });
      }

      case "remove_member": {
        const userId = Number(body.userId);
        if (!Number.isInteger(userId)) {
          return NextResponse.json({ ok: false, message: "대상이 올바르지 않습니다." }, { status: 400 });
        }
        if (userId === me.userId) {
          return NextResponse.json(
            { ok: false, message: "자기 자신은 뺄 수 없습니다." },
            { status: 400 },
          );
        }
        await removeTeamMember(db, me.teamId, userId);
        await recordAudit(db, {
          actor, teamId: me.teamId, action: "team_remove_member", requestId: null,
          result: "ok", detail: `user=${userId}`,
        });
        return NextResponse.json({ ok: true });
      }

      default:
        return NextResponse.json({ ok: false, message: `모르는 동작입니다: ${action}` }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  } finally {
    await db.close();
  }
}

async function countOwners(db: import("../../../lib/dbCore.ts").Db, teamId: string): Promise<number> {
  const row = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND role = 'owner'",
    [teamId],
  );
  return Number(row?.n ?? 0);
}
