/**
 * 밀린 Jira 반영을 처리한다.
 *
 * ## 누가 깨우나 — 화면이다
 *
 * 이 레포에는 Jira 용 워커가 없고, 웹 컨테이너는 **스스로 깨어나지 않는다**.
 * 자동 게시가 같은 문제를 "화면에 들어오면 엔드포인트를 한 번 부른다" 로 풀었고
 * (app/closed/AutoPublishKick.tsx), 그 근거 주석이 거기 있다. 같은 방식을 쓴다.
 *
 * 멱등하다 — 여러 사람이 동시에 캘린더를 열어 여러 번 깨워도 이슈가 중복되지 않는다
 * (lib/calendarJira.ts 의 멱등 라벨 + 라벨 조회).
 *
 * 한 번에 처리하는 건수를 묶어 둔다. Jira 호출이 **웹 요청 안에서 동기로** 나가므로,
 * 느린 Jira 가 화면 진입을 붙잡지 않게 하기 위해서다.
 */
import { NextResponse } from "next/server";
import { userFromRequestWith } from "../../../../lib/appAuth.ts";
import { syncEventToJira, syncPendingEvents } from "../../../../lib/calendarJira.ts";
import { openDb } from "../../../../lib/db.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // 본문 없이 불러도 된다 — 화면 진입 kick 이 그렇게 부른다.
  }

  const db = await openDb();
  try {
    const me = await userFromRequestWith(db, request);
    if (me === null) {
      return NextResponse.json({ ok: false, message: "로그인이 필요합니다." }, { status: 401 });
    }
    if (me.teamId === "") {
      return NextResponse.json({ ok: true, results: [] });
    }

    // 한 건을 지정해 **사람이 다시 시도**하는 경우. 상한에 닿았어도 한 번 더 해 본다.
    const eventId = Number(body.eventId);
    if (Number.isInteger(eventId) && eventId > 0) {
      const result = await syncEventToJira(db, me.teamId, eventId, { force: true });
      return NextResponse.json({ ok: true, results: [result] });
    }

    return NextResponse.json({ ok: true, results: await syncPendingEvents(db, me.teamId) });
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  } finally {
    await db.close();
  }
}
