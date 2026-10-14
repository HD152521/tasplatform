import { NextResponse } from "next/server";
import { fetchClient } from "../../../collector/httpClient.ts";
import { sessionFileForTeam } from "../../../lib/config.ts";
import { categoryIdOf } from "../../../lib/productCategory.ts";
import { ReleaseLookupError, findReleases } from "../../../lib/releaseList.ts";
import { ensureTeamSession, resolveActorTeam } from "../../../lib/requestAudit.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 그 제품의 Prod Release 선택지를 돌려준다.
 *
 * ## 왜 포털에 그때그때 묻나
 *
 * 릴리스는 계속 나온다. 목록을 코드에 박아 두면 그 순간부터 썩고, 새 버전으로 SR 을
 * 올릴 수 없게 된다. 그래서 묻는다(lib/releaseList.ts 머리말).
 *
 * ## 검색어를 꼭 받는다
 *
 * 포털의 이 필드는 **검색형**이다(minChar 1). 검색어를 주면 그 제품의 릴리스 중 글자가
 * 들어간 것을 돌려준다. 빈 검색어로도 목록이 오지만 **그것은 전체가 아니다** — 실측으로
 * TAS 는 빈 검색어에 69건이 오는데 "10.4" 로 검색하면 그 69건에 없는 타일 릴리스가
 * 32건 더 나온다. 그래서 빈 목록을 "허용 목록" 으로 쓰면 **멀쩡한 버전을 거부한다.**
 * 검색 결과는 제품으로 제대로 걸러진다(교차 확인: GemFire 에 TAS 전용 `2412` 를 물으면
 * 0건, ESXi 전용 `9.1.1.0` 도 0건이다).
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const productId = Number(url.searchParams.get("productId"));
  const q = (url.searchParams.get("q") ?? "").trim();

  if (!Number.isInteger(productId) || productId <= 0) {
    return NextResponse.json({ ok: false, message: "제품을 먼저 고르세요." }, { status: 400 });
  }

  const categoryId = categoryIdOf(productId);
  if (categoryId === null) {
    // 표에 없는 제품이다. 그 제품은 지금 이 경로로 등록할 수 없다 —
    // 릴리스를 못 고르는 것이 아니라 등록 자체가 거절된다(lib/productCategory.ts).
    return NextResponse.json(
      { ok: false, code: "unknown_product", message: "이 제품은 아직 릴리스 목록을 조회할 수 없습니다." },
      { status: 400 },
    );
  }

  const actorTeam = resolveActorTeam({ team: url.searchParams.get("team") ?? undefined });
  if (!actorTeam.ok) {
    return NextResponse.json({ ok: false, message: actorTeam.message }, { status: 400 });
  }
  const { teamId } = actorTeam;
  // 조회라 감사 로그는 남기지 않는다.
  const noSession = await ensureTeamSession(teamId);
  if (noSession !== null) return noSession;

  try {
    const releases = await findReleases(fetchClient(sessionFileForTeam(teamId)), categoryId, q);
    return NextResponse.json({ ok: true, categoryId, releases });
  } catch (error) {
    // 세션 만료도 여기로 온다(ReleaseLookupError). 문구를 그대로 보여 준다 —
    // 사람이 할 일이 다르다(재로그인 vs 다시 시도).
    const message = error instanceof ReleaseLookupError || error instanceof Error
      ? error.message
      : String(error);
    console.error("[api/releases]", error);
    return NextResponse.json({ ok: false, message }, { status: 502 });
  }
}
