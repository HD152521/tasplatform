import { NextResponse } from "next/server";
import { fetchClient } from "../../../collector/httpClient.ts";
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
  if (!hasTeamSession(teamId)) {
    return NextResponse.json({ ok: true, state: "dead" });
  }

  const state = await probeSession(fetchClient(sessionFileForTeam(teamId)));
  return NextResponse.json({ ok: true, state });
}
