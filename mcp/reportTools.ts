/**
 * 정기점검 보고서 MCP 도구.
 *
 * 화면(app/report/*)에만 있던 기능을 외부 챗봇이 쓸 수 있게 연다.
 *
 * 인자는 평평한 원시값으로만 받는다 — 연·월은 숫자 둘, 인스턴스 수치는 숫자 아홉.
 * "2026-08" 같은 합친 문자열을 받으면 챗봇이 연도를 스스로 알아내야 하고("8월달"
 * 이라고만 말하는 것이 보통이다), 중첩 객체를 받으면 붙는 쪽 클라이언트가 그 JSON
 * Schema 를 다룬다는 보장이 없다(상대 스펙에 중첩 언급이 없다). 기존 도구 다섯 개도
 * 전부 평평한 값만 받는다.
 *
 * 파일은 도구 응답에 싣지 않고 **다운로드 주소만** 돌려준다. Claude·ChatGPT 도 같은
 * 구조다 — 샌드박스에서 파일을 만들고 저장소에 올린 뒤 대화에는 참조만 보낸다.
 * 바이트를 대화에 실으면 토큰이 터지고, 응답이 끊기면 파일까지 다시 만들어야 하며,
 * 붙는 쪽이 그 blob 을 파일로 복원해 준다는 보장도 없다.
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
import type { InstanceInput, PreviousMonth } from "../lib/instanceCount.ts";
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

export interface MonthArgs {
  year?: unknown;
  month?: unknown;
}

/**
 * 연·월을 'YYYY-MM' 로 맞춘다.
 *
 * 연도는 2000~2100 만 받는다 — 챗봇이 "26" 같은 두 자리를 넣는 일이 있는데, 그대로
 * 두면 0026년을 조회하고 빈 결과를 정상처럼 돌려준다.
 */
export function monthKeyOf(args: MonthArgs): { key: string } | { message: string } {
  const year = typeof args.year === "number" ? args.year : Number(args.year);
  const month = typeof args.month === "number" ? args.month : Number(args.month);

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return { message: `year 가 올바르지 않습니다 (2000~2100 의 네 자리): ${String(args.year)}` };
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return { message: `month 가 올바르지 않습니다 (1~12): ${String(args.month)}` };
  }
  return { key: `${year}-${String(month).padStart(2, "0")}` };
}

/** 채팅이 물어봐야 할 아홉 칸. 순서가 곧 물어보는 순서다. */
export const REQUIRED_COUNTS = [
  "bankDev", "bankProd", "bankDr",
  "centralDev", "centralProd", "centralDr",
  "sharedDev", "sharedProd", "sharedDr",
] as const;

export type CountArgs = Partial<Record<(typeof REQUIRED_COUNTS)[number], unknown>>;

/**
 * 아홉 칸을 검사해 InstanceInput 으로 만든다.
 *
 * 하나라도 비면 무엇이 빠졌는지 돌려준다 — 챗봇이 그걸 보고 사용자에게 물어볼 수 있게.
 * 빠진 값을 0 으로 채우지 않는다. 0 은 "없음" 이라는 뜻이라 지어내면 표가 틀어진다.
 */
export function readCounts(args: CountArgs): { input: InstanceInput } | { missing: string[] } {
  const missing: string[] = [];
  const pick = (name: (typeof REQUIRED_COUNTS)[number]): number => {
    const value = args[name];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      missing.push(name);
      return 0;
    }
    return value;
  };

  const input: InstanceInput = {
    bank: { dev: pick("bankDev"), prod: pick("bankProd"), dr: pick("bankDr") },
    central: { dev: pick("centralDev"), prod: pick("centralProd"), dr: pick("centralDr") },
    shared: { dev: pick("sharedDev"), prod: pick("sharedProd"), dr: pick("sharedDr") },
  };
  return missing.length > 0 ? { missing } : { input };
}

/** 하나라도 수치를 준 건가. 아무것도 안 줬으면 저장된 값을 쓴다. */
export function hasAnyCount(args: CountArgs): boolean {
  return REQUIRED_COUNTS.some((name) => args[name] !== undefined);
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
  args: MonthArgs,
): Promise<ReportResult<{ month: string; rows: unknown[]; skipped: unknown[]; scanned: number }>> {
  const parsed = monthKeyOf(args);
  if ("message" in parsed) return { ok: false, message: parsed.message };

  const config = deps.atlassianConfig();
  if (config === null) return { ok: false, message: "Atlassian 설정이 없습니다." };
  if (config.jiraProject === "") {
    return { ok: false, message: "JIRA_PROJECT 가 설정되지 않았습니다." };
  }

  const result = await deps.fetchMonthlyWork(config, parsed.key);
  return {
    ok: true,
    month: parsed.key,
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
  args: MonthArgs,
): Promise<ReportResult<{ month: string; saved: SavedMonth | null; required: readonly string[] }>> {
  const parsed = monthKeyOf(args);
  if ("message" in parsed) return { ok: false, message: parsed.message };
  return {
    ok: true,
    month: parsed.key,
    saved: await deps.loadMonth(parsed.key),
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
  args: MonthArgs & CountArgs,
): Promise<
  ReportResult<{
    month: string;
    url: string;
    saved: SavedMonth | null;
    previousFrom: string | null;
    note: string;
  }>
> {
  const parsed = monthKeyOf(args);
  if ("message" in parsed) return { ok: false, message: parsed.message };
  const month = parsed.key;

  let saved: SavedMonth | null = null;
  let previousFrom: string | null = null;

  if (hasAnyCount(args)) {
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
