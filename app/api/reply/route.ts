import { NextResponse } from "next/server";
import { isClosedStatus, getCase } from "../../../lib/queries.ts";
import { postReply } from "../../../lib/reply.ts";
import { fetchClient } from "../../../collector/httpClient.ts";
import { sessionFileForTeam } from "../../../lib/config.ts";
import { refreshCaseThreads } from "../../../lib/refreshCase.ts";
import { hasTeamSession, recordWriteAudit, resolveActorTeam, runSideEffect } from "../../../lib/requestAudit.ts";
import { hydrateTeamSessionFromDb, persistTeamSessionToDb } from "../../../lib/sessionStore.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { requestId?: unknown; text?: unknown; actor?: unknown; team?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: "잘못된 요청입니다." }, { status: 400 });
  }

  const requestId = Number(body.requestId);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!Number.isFinite(requestId) || text === "") {
    return NextResponse.json({ ok: false, message: "내용을 입력하세요." }, { status: 400 });
  }

  // actor/team 없이 호출하는 기존 뷰어 화면과 하위호환: team 미제공시 기본 팀,
  // actor 미제공시 빈 문자열로 처리한다. team 형식이 잘못됐을 때만 여기서 걸린다.
  const actorTeam = resolveActorTeam(body);
  if (!actorTeam.ok) {
    return NextResponse.json({ ok: false, message: actorTeam.message }, { status: 400 });
  }
  const { actor, teamId } = actorTeam;

  // 재시작으로 로컬 세션 파일이 없을 수 있으니 DB 백업에서 먼저 복원한다(hasTeamSession 전).
  await hydrateTeamSessionFromDb(teamId);

  // 종료된 케이스에는 보내지 않는다.
  const detail = await getCase(requestId);
  if (detail === null) {
    await recordWriteAudit({ actor, teamId, action: "reply", requestId, result: "failed:not_found" });
    return NextResponse.json({ ok: false, message: "케이스를 찾을 수 없습니다." }, { status: 404 });
  }
  if (isClosedStatus(detail.status)) {
    await recordWriteAudit({ actor, teamId, action: "reply", requestId, result: "failed:closed" });
    return NextResponse.json(
      { ok: false, message: "종료된 케이스에는 답변할 수 없습니다." },
      { status: 400 },
    );
  }

  // 쓰기 시도 전에 세션 파일부터 확인한다. 없으면 브로드컴에 요청조차 보내지 않는다.
  if (!hasTeamSession(teamId)) {
    await recordWriteAudit({ actor, teamId, action: "reply", requestId, result: "failed:session" });
    return NextResponse.json(
      { ok: false, code: "session", message: "세션이 없습니다. SR 페이지에서 로그인하세요." },
      { status: 401 },
    );
  }

  // 브라우저를 띄우지 않는다. 실측상 세션 확보에만 40초 넘게 들었고,
  // 답변 전송은 사람이 화면 앞에서 기다리는 구간이다.
  try {
    const client = fetchClient(sessionFileForTeam(teamId));
    const result = await postReply(client, requestId, text);

    // 쓰기(postReply) 결과가 이미 응답을 결정한다. 아래 부수효과(쿠키 저장·새로고침)가
    // 실패해도 성공을 실패로 뒤집으면 안 된다 — 안 그러면 사용자가 재시도해서
    // 브로드컴에 중복 답변이 생긴다. 그래서 예외를 삼키는 runSideEffect 로만 건드린다.
    await runSideEffect("reply persist", () => client.persist());
    // 회전된 세션 쿠키를 DB 로 백업(재시작 후 hydrate 로 복원).
    await runSideEffect("reply session→db", () => persistTeamSessionToDb(teamId));

    // 전송에 성공했으면 그 케이스만 즉시 다시 읽어 화면에 바로 보이게 한다.
    // 정기 수집(15분)을 기다리면 자기가 방금 쓴 글이 안 보인다.
    if (result.ok) {
      await runSideEffect("reply refresh", () => refreshCaseThreads(client, requestId));
    }

    await recordWriteAudit({
      actor, teamId, action: "reply", requestId,
      result: result.ok ? "ok" : `failed:${result.code}`,
    });

    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  } catch (error) {
    // 여기 닿는 것은 postReply 자체(또는 fetchClient 생성)가 던진, 진짜 예상 못한
    // 오류뿐이다 — 세션 없음은 위에서 이미 걸렀다.
    const message = error instanceof Error ? error.message : String(error);
    await recordWriteAudit({ actor, teamId, action: "reply", requestId, result: "failed:session" });
    return NextResponse.json(
      { ok: false, code: "session", message },
      { status: 401 },
    );
  }
}
