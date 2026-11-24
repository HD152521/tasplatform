import { NextResponse } from "next/server";
import { fetchClient } from "../../../collector/httpClient.ts";
import { readCollectorHealth } from "../../../lib/collectorHealth.ts";
import { openDb } from "../../../lib/db.ts";
import { sessionFileForTeam } from "../../../lib/config.ts";
import { hasTeamSession, resolveActorTeam } from "../../../lib/requestAudit.ts";
import { probeSession } from "../../../lib/sessionProbe.ts";
import { hydrateTeamSessionFromDb } from "../../../lib/sessionStore.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 세션이 **지금** 살아 있는지 알려준다.
 *
 * 화면 왼쪽 아래 표시는 쿠키 만료 시각만 보고 그려서, 수집기가 재로그인해 앞선 세션이
 * 죽은 뒤에도 "연결됨" 이라고 말한다(lib/sessionProbe.ts 머리말). 그 거짓말은 5분 쓴
 * 답변을 전송하는 순간에야 드러났다. 이 라우트가 진실을 돌려준다.
 *
 * **레이아웃에서 부르지 않는다.** 포털 왕복이 0.15~0.6초라 모든 페이지가 그만큼
 * 느려진다. 화면을 그린 뒤 브라우저가 따로 물어본다(app/SessionDot.tsx).
 *
 * 쓰기가 아니므로 감사 로그를 남기지 않는다 — 조회를 남기면 로그가 조회로 덮인다
 * (lib/requestAudit.ts 의 ensureTeamSession 주석과 같은 이유).
 *
 * ## 수집기 상태를 함께 준다
 *
 * 세션이 죽었을 때 사람이 할 일은 **웹에서 로그인하는 것이 아니다** — 컨테이너에
 * 브라우저가 없어 그게 안 된다. 세션을 다시 만드는 것은 수집기이고, 수집기는 회차를
 * 시작할 때 죽은 세션을 스스로 되살린다. 그래서 할 일은 "한 회차를 지금 돌려 달라고
 * 요청하는 것" 이다.
 *
 * 단 **수집기가 돌고 있어야** 뜻이 있다. 멈춰 있으면 요청은 줄에 남아 아무 일도
 * 일어나지 않는데, 화면이 "요청했습니다" 만 보여 주면 사람은 영원히 기다린다. 그래서
 * 한 번의 조회로 둘을 함께 답한다(lib/collectorHealth.ts).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const actorTeam = resolveActorTeam({ team: url.searchParams.get("team") ?? undefined });
  if (!actorTeam.ok) {
    return NextResponse.json({ ok: false, message: actorTeam.message }, { status: 400 });
  }
  const { teamId } = actorTeam;

  // 재시작으로 로컬 파일이 없을 수 있다. DB 백업에서 먼저 복원한다.
  await hydrateTeamSessionFromDb(teamId);

  const state = hasTeamSession(teamId)
    ? await probeSession(fetchClient(sessionFileForTeam(teamId)))
    : "dead";

  /*
   * 수집기 상태는 **세션이 살아 있어도** 함께 준다. 쓰기 직전에 세션이 죽는 것이 이
   * 자리의 문제라, 화면이 그때 다시 묻지 않고 바로 안내할 수 있어야 한다.
   *
   * 읽기 실패로 세션 답까지 버리지 않는다 — 수집기 상태는 곁다리다.
   */
  let collector = null;
  const db = await openDb();
  try {
    collector = await readCollectorHealth(db);
  } catch {
    // DB 를 못 읽어도 세션 상태는 돌려준다.
  } finally {
    await db.close();
  }

  return NextResponse.json({ ok: true, state, collector });
}
