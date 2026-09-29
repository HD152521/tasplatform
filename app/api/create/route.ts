import { NextResponse } from "next/server";
import { PRIORITIES, createCase } from "../../../lib/createCase.ts";
import { fetchClient } from "../../../collector/httpClient.ts";
import { sessionFileForTeam } from "../../../lib/config.ts";
import { refreshOpenCases } from "../../../lib/refreshCase.ts";
import { hasTeamSession, recordWriteAudit, resolveActorTeam, runSideEffect } from "../../../lib/requestAudit.ts";
import {
  hydrateTeamSessionFromDb,
  persistTeamSessionToDb,
  refreshTeamSessionFromDb,
} from "../../../lib/sessionStore.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: {
    subject?: unknown; content?: unknown; priorityId?: unknown;
    productId?: unknown; componentId?: unknown; actor?: unknown; team?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: "잘못된 요청입니다." }, { status: 400 });
  }

  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const content = typeof body.content === "string" ? body.content.trim() : "";
  const priorityId = Number(body.priorityId);

  if (subject === "" || content === "") {
    return NextResponse.json({ ok: false, message: "제목과 내용을 입력하세요." }, { status: 400 });
  }
  if (!PRIORITIES.some((p) => p.id === priorityId)) {
    return NextResponse.json({ ok: false, message: "우선순위가 올바르지 않습니다." }, { status: 400 });
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

  // 쓰기 시도 전에 세션 파일부터 확인한다. 없으면 브로드컴에 요청조차 보내지 않는다.
  // fetchClient 는 SessionExpiredError/SessionMissingError 를 던지지 않으므로
  // (그건 브라우저 로그인 경로 전용), 세션 없음은 반드시 여기서 걸러야 한다.
  if (!hasTeamSession(teamId)) {
    await recordWriteAudit({ actor, teamId, action: "create_sr", requestId: null, result: "failed:session" });
    return NextResponse.json(
      { ok: false, code: "session", message: "세션이 없습니다. SR 페이지에서 로그인하세요." },
      { status: 401 },
    );
  }

  // 브라우저를 띄우지 않는다. 쓰기 경로는 사람이 앞에서 기다리는 구간이다.
  try {
    const client = fetchClient(sessionFileForTeam(teamId));
    const productId = Number(body.productId);
    const componentId = Number(body.componentId);
    const draft = {
      subject, content, priorityId,
      productId: Number.isFinite(productId) ? productId : undefined,
      componentId: Number.isFinite(componentId) ? componentId : undefined,
    };
    let result = await createCase(client, draft);

    // 세션이 **만료 시각 전에도 죽는다**(app/api/reply/route.ts 의 같은 자리 참고).
    // 401 을 받은 이 순간이 진실이라, 최신본을 끌어와 한 번만 다시 보낸다.
    //
    // 재시도해도 케이스가 둘 생기지 않는다 — 앞선 시도는 401 로 거절당해 아무것도
    // 만들지 않았다. 그게 아닌 실패(code 가 session 이 아닌 것)는 재시도하지 않는다.
    if (!result.ok && result.code === "session" && await refreshTeamSessionFromDb(teamId)) {
      result = await createCase(fetchClient(sessionFileForTeam(teamId)), draft);
    }

    // 쓰기(createCase) 결과가 이미 응답을 결정한다. 아래 부수효과(쿠키 저장·목록
    // 새로고침)가 실패해도 성공을 실패로 뒤집으면 안 된다 — 안 그러면 사용자가
    // 재시도해서 브로드컴에 중복 케이스가 생긴다. 그래서 runSideEffect 로만 건드린다.
    await runSideEffect("create persist", () => client.persist());
    // 회전된 세션 쿠키를 DB 로 백업(재시작 후 hydrate 로 복원).
    await runSideEffect("create session→db", () => persistTeamSessionToDb(teamId));

    // 새 케이스는 DB 에 행 자체가 없다. 진행중 목록을 한 번 받아 채워 넣고,
    // 방금 만든 건은 본문·스레드까지 받아 둔다 — 안 그러면 열어도 내용이 비어 보인다.
    if (result.ok) {
      await runSideEffect("create refresh", () => refreshOpenCases(client, teamId, result.requestId));
    }

    await recordWriteAudit({
      actor, teamId, action: "create_sr",
      requestId: result.ok ? result.requestId : null,
      result: result.ok ? "ok" : `failed:${result.code}`,
    });

    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  } catch (error) {
    // 여기 닿는 것은 createCase 자체(또는 fetchClient 생성)가 던진, 진짜 예상 못한
    // 오류뿐이다 — 세션 없음은 위에서 이미 걸렀다.
    const message = error instanceof Error ? error.message : String(error);
    console.error("[api/create]", error);
    await recordWriteAudit({ actor, teamId, action: "create_sr", requestId: null, result: "failed:error" });
    return NextResponse.json(
      { ok: false, code: "failed", message },
      { status: 500 },
    );
  }
}
