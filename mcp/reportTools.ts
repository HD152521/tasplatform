/**
 * 정기점검 보고서 MCP 도구.
 *
 * 화면(app/report/*)에만 있던 기능을 외부 챗봇이 쓸 수 있게 연다.
 *
 * 파일은 도구 응답에 싣지 않고 **다운로드 주소만** 돌려준다. Claude·ChatGPT 도 같은
 * 구조다 — 샌드박스에서 파일을 만들고, 저장소에 올린 뒤, 대화에는 참조(file_id·경로)만
 * 보낸다. 바이트를 대화에 실으면 토큰이 터지고, 응답이 끊기면 파일까지 다시 만들어야
 * 하며, 붙는 쪽이 그 blob 을 파일로 복원해 준다는 보장도 없다.
 *
 * 실용적인 이유가 하나 더 있다. 보고서 빌드는 SR 건수만큼 AI 를 불러 오래 걸린다
 * (app/api/report/build/route.ts 가 maxDuration 900 을 잡아 둔 이유). 붙는 쪽 연결
 * 타임아웃은 60초다. 도구 안에서 빌드하면 거의 확실히 끊긴다. 주소만 돌려주면 빌드는
 * 링크를 열 때 그쪽 예산 안에서 일어난다.
 *
 * lib/jira.ts·lib/instanceStore.ts 는 server-only 라 값으로 불러오지 않고 주입받는다
 * (mcp/serverDeps.ts 가 배선한다). 그래야 이 파일을 평범한 node --test 로 시험할 수 있다.
 */
import type { AtlassianConfig } from "../lib/atlassian.ts";
import type { EnvCount, InstanceInput, PreviousMonth } from "../lib/instanceCount.ts";
import type { SavedMonth } from "../lib/instanceStore.ts";
import type { WorkResult } from "../lib/jira.ts";

export interface ReportDeps {
  /** null 이면 Atlassian 설정이 없다. */
  atlassianConfig: () => AtlassianConfig | null;
  fetchMonthlyWork: (config: AtlassianConfig, month: string) => Promise<WorkResult>;
  loadMonth: (month: string) => Promise<SavedMonth | null>;
  saveMonth: (month: string, input: InstanceInput, previous: PreviousMonth) => Promise<SavedMonth>;
  resolvePrevious: (month: string) => Promise<{ values: PreviousMonth; fromMonth: string | null }>;
  /** 다운로드 주소의 앞부분. 보통 SR_APP_URL. */
  appUrl: string;
}

export type ReportResult<T> = ({ ok: true } & T) | { ok: false; message: string };

/** 'YYYY-MM' 인가. lib/instanceStore.ts 의 isMonth 와 같은 판정이되 주입이 필요 없다. */
export function isMonthArg(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** 채팅이 물어봐야 할 아홉 칸. 순서가 곧 물어보는 순서다. */
export const REQUIRED_COUNTS = [
  "bank.dev", "bank.prod", "bank.dr",
  "central.dev", "central.prod", "central.dr",
  "shared.dev", "shared.prod", "shared.dr",
] as const;

interface CountArgs {
  bank?: Partial<EnvCount>;
  central?: Partial<EnvCount>;
  shared?: Partial<EnvCount>;
}

/**
 * 아홉 칸을 검사해 InstanceInput 으로 만든다.
 *
 * 하나라도 비면 무엇이 빠졌는지 돌려준다 — 챗봇이 그걸 보고 사용자에게 물어볼 수 있게.
 * 빠진 값을 0 으로 채우지 않는다. 0 은 "없음" 이라는 뜻이라 지어내면 표가 틀어진다.
 */
export function readCounts(args: CountArgs): { input: InstanceInput } | { missing: string[] } {
  const missing: string[] = [];
  const pick = (group: Partial<EnvCount> | undefined, env: keyof EnvCount, label: string): number => {
    const value = group?.[env];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      missing.push(label);
      return 0;
    }
    return value;
  };

  const input: InstanceInput = {
    bank: {
      dev: pick(args.bank, "dev", "bank.dev"),
      prod: pick(args.bank, "prod", "bank.prod"),
      dr: pick(args.bank, "dr", "bank.dr"),
    },
    central: {
      dev: pick(args.central, "dev", "central.dev"),
      prod: pick(args.central, "prod", "central.prod"),
      dr: pick(args.central, "dr", "central.dr"),
    },
    shared: {
      dev: pick(args.shared, "dev", "shared.dev"),
      prod: pick(args.shared, "prod", "shared.prod"),
      dr: pick(args.shared, "dr", "shared.dr"),
    },
  };
  return missing.length > 0 ? { missing } : { input };
}

/** 보고서 다운로드 주소. 빌드는 이 주소를 열 때 일어난다. */
export function downloadUrl(appUrl: string, month: string): string {
  return `${appUrl.replace(/\/+$/, "")}/api/report/build?month=${encodeURIComponent(month)}`;
}

/* ------------------------------------------------------------------ *
 * 도구 핸들러
 * ------------------------------------------------------------------ */

/** 그 달의 작업 진행 현황. 합치기 규칙은 lib/jiraFormat.ts 가 적용한 그대로다. */
export async function getMonthlyWorkHandler(
  deps: ReportDeps,
  args: { month?: unknown },
): Promise<ReportResult<{ month: string; rows: unknown[]; skipped: unknown[]; scanned: number }>> {
  if (!isMonthArg(args.month)) {
    return { ok: false, message: "month 가 올바르지 않습니다 (YYYY-MM)." };
  }
  const config = deps.atlassianConfig();
  if (config === null) {
    return { ok: false, message: "Atlassian 설정이 없습니다." };
  }
  if (config.jiraProject === "") {
    return { ok: false, message: "JIRA_PROJECT 가 설정되지 않았습니다." };
  }

  const result = await deps.fetchMonthlyWork(config, args.month);
  return {
    ok: true,
    month: args.month,
    // 전산센터·법인은 합쳐지면 줄바꿈으로 이어져 있다(보고서가 한 칸에 문단을 나눠 쓴다).
    rows: result.rows,
    // 보고서에서 빠진 이슈와 이유. 왜 안 보이는지 묻는 일이 잦다.
    skipped: result.skipped,
    scanned: result.scanned,
  };
}

/** 저장된 인스턴스 수치. 없으면 무엇을 채워야 하는지 알려 준다. */
export async function getInstanceCountsHandler(
  deps: ReportDeps,
  args: { month?: unknown },
): Promise<ReportResult<{ month: string; saved: SavedMonth | null; required: readonly string[] }>> {
  if (!isMonthArg(args.month)) {
    return { ok: false, message: "month 가 올바르지 않습니다 (YYYY-MM)." };
  }
  return {
    ok: true,
    month: args.month,
    saved: await deps.loadMonth(args.month),
    required: REQUIRED_COUNTS,
  };
}

/**
 * 입력값을 저장하고 다운로드 주소를 돌려준다.
 *
 * 수치를 안 주면 저장된 것을 쓴다. 그것도 없으면 무엇이 필요한지 돌려주므로,
 * 챗봇이 그걸 보고 사용자에게 아홉 칸을 물어볼 수 있다.
 */
export async function buildReportHandler(
  deps: ReportDeps,
  args: { month?: unknown } & CountArgs,
): Promise<
  ReportResult<{
    month: string;
    url: string;
    saved: SavedMonth | null;
    previousFrom: string | null;
    note: string;
  }>
> {
  if (!isMonthArg(args.month)) {
    return { ok: false, message: "month 가 올바르지 않습니다 (YYYY-MM)." };
  }
  const month = args.month;
  const given = args.bank !== undefined || args.central !== undefined || args.shared !== undefined;

  let saved: SavedMonth | null = null;
  let previousFrom: string | null = null;

  if (given) {
    const counts = readCounts(args);
    if ("missing" in counts) {
      return {
        ok: false,
        message: `인스턴스 수치가 모자랍니다. 다음 값을 사용자에게 물어 채워 주세요: ${counts.missing.join(", ")}`,
      };
    }
    // 전월값은 이전 달 저장분에서 끌어온다. 없으면 빈 값이고, 그때는 증감이 0 으로 나온다.
    const previous = await deps.resolvePrevious(month);
    previousFrom = previous.fromMonth;
    saved = await deps.saveMonth(month, counts.input, previous.values);
  } else {
    saved = await deps.loadMonth(month);
    if (saved === null) {
      return {
        ok: false,
        message:
          `${month} 의 인스턴스 수치가 저장되어 있지 않습니다. ` +
          `다음 아홉 값을 사용자에게 물어 함께 넘겨 주세요: ${REQUIRED_COUNTS.join(", ")}`,
      };
    }
  }

  return {
    ok: true,
    month,
    url: downloadUrl(deps.appUrl, month),
    saved,
    previousFrom,
    note:
      "이 주소를 열면 보고서가 만들어져 내려받아집니다. " +
      "SR 건수만큼 AI 를 부르므로 몇 분 걸릴 수 있습니다.",
  };
}
