import { NextResponse } from "next/server";
import { AtlassianError, atlassianConfig } from "../../../../lib/atlassian.ts";
import { fetchMonthlyWork } from "../../../../lib/jira.ts";
import { isMonth } from "../../../../lib/instanceStore.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 해당 월의 작업 진행 현황을 Jira 에서 읽어 온다. 읽기 전용이다. */
export async function GET(request: Request) {
  const month = new URL(request.url).searchParams.get("month") ?? "";
  if (!isMonth(month)) {
    return NextResponse.json(
      { ok: false, message: "대상 월이 올바르지 않습니다 (YYYY-MM)." },
      { status: 400 },
    );
  }

  const config = atlassianConfig();
  if (config === null) {
    return NextResponse.json(
      { ok: false, message: ".env 에 ATLASSIAN_BASE / ATLASSIAN_EMAIL / ATLASSIAN_TOKEN 이 필요합니다." },
      { status: 503 },
    );
  }
  if (config.jiraProject === "") {
    return NextResponse.json(
      { ok: false, message: ".env 에 JIRA_PROJECT 가 필요합니다." },
      { status: 503 },
    );
  }

  try {
    const result = await fetchMonthlyWork(config, month);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    // 조회 실패를 "이슈 0건" 처럼 보이게 하지 않는다.
    if (error instanceof AtlassianError) {
      const hint = error.status === 401 || error.status === 403
        ? " 토큰이 만료되었거나 권한이 없습니다."
        : "";
      return NextResponse.json(
        { ok: false, message: `Jira 조회 실패 (HTTP ${error.status}).${hint}` },
        { status: 502 },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, message: `Jira 조회 실패: ${message}` }, { status: 502 });
  }
}
