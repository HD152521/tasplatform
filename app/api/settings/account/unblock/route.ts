/**
 * 「비밀번호 그대로 한 번만 다시 시도」 — 멈춤을 사람이 푼다.
 *
 * 멈춤은 **계정이 잠기는 것을 막기 위한** 장치고, 시간이 지나도 저절로 풀리지 않는다
 * (lib/loginGuard.ts 머리말). 푸는 것은 언제나 사람의 명시적 동작이다.
 *
 * 여기서는 `attempts: "one"` 으로 푼다 — 저장된 값이 그대로이므로 또 거절당할 가능성이
 * 높다. 한 번만 시도하고 실패하면 즉시 다시 멈춘다. 버튼을 반복해서 눌러도 IdP 의
 * 실패 횟수가 2개씩 쌓이지 않게 하는 장치다.
 *
 * 비밀번호를 바꿨다면 이 버튼이 아니라 **저장**이 맞다(그쪽은 처음부터 다시 센다).
 */
import { NextResponse } from "next/server";
import { actorOf, userFromRequestWith } from "../../../../../lib/appAuth.ts";
import { openDb, recordAudit } from "../../../../../lib/db.ts";
import { clearLoginGuard, readLoginGuard } from "../../../../../lib/loginGuard.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const db = await openDb();
  try {
    // 누르는 사람과 **그 사람의 팀**을 세션에서 읽는다. 공용 계정은 팀에 귀속되므로
    // 남의 팀 잠금을 풀어 주면 그 팀의 IdP 실패 횟수를 대신 쓰게 된다.
    const me = await userFromRequestWith(db, request);
    if (me === null) {
      return NextResponse.json({ ok: false, message: "로그인이 필요합니다." }, { status: 401 });
    }
    if (me.teamId === "") {
      return NextResponse.json({ ok: false, message: "속한 팀이 없습니다." }, { status: 400 });
    }
    const actor = actorOf(me);

    await clearLoginGuard(db, me.teamId, "화면에서 「한 번만 다시 시도」", "one");
    await recordAudit(db, {
      actor, teamId: me.teamId, action: "portal_login_unblock", requestId: null,
      result: "ok", detail: "",
    });
    return NextResponse.json({ ok: true, guard: await readLoginGuard(db, me.teamId) });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  } finally {
    await db.close();
  }
}
