import { NextResponse } from "next/server";
import { isClosedStatus, getCase } from "../../../lib/queries.ts";
import { postReply } from "../../../lib/reply.ts";
import { fetchClient } from "../../../collector/httpClient.ts";
import { sessionFileForTeam } from "../../../lib/config.ts";
import { refreshCaseThreads } from "../../../lib/refreshCase.ts";
import { hasTeamSession, recordWriteAudit, resolveActorTeam, runSideEffect } from "../../../lib/requestAudit.ts";
import {
  hydrateTeamSessionFromDb,
  persistTeamSessionToDb,
  refreshTeamSessionFromDb,
} from "../../../lib/sessionStore.ts";

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
    let result = await postReply(client, requestId, text);

    // 세션이 **만료 시각 전에도 죽는다.** 수집기가 재로그인하면 앞선 세션이 서버 쪽에서
    // 무효가 되는데 쿠키의 만료 시각은 여전히 미래라, hydrate 는 "살아 있다" 고 보고
    // DB 를 쳐다보지 않는다. Broadcom 이 401 을 주는 이 순간이 진실이다 —
    // 최신본을 끌어와 **한 번만** 다시 보낸다. 사람이 앞에서 기다리는 구간이라
    // 여러 번 되풀이하지 않는다.
    if (!result.ok && result.code === "session" && await refreshTeamSessionFromDb(teamId)) {
      result = await postReply(fetchClient(sessionFileForTeam(teamId)), requestId, text);
    }

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
    // 오류뿐이다 — 세션 만료는 값(code:"session")으로 돌아오지 예외로 오지 않는다.
    //
    // 예전에는 이걸 전부 code:"session" + 401 로 돌려줬다. 그래서 망 오류나 타임아웃
    // 같은 세션과 무관한 실패까지 "세션이 만료되었습니다" 로 보였고, 담당자는 재로그인만
    // 되풀이하며 엉뚱한 곳을 팠다. 감사 로그에도 failed:session 으로 남아 원인 분석을
    // 막았다. 옆의 create 라우트는 처음부터 이렇게 나눠 처리하고 있었다.
    const message = error instanceof Error ? error.message : String(error);
    console.error("[api/reply]", error);
    await recordWriteAudit({ actor, teamId, action: "reply", requestId, result: "failed:error" });
    return NextResponse.json(
      { ok: false, code: "failed", message },
      { status: 500 },
    );
  }
}
