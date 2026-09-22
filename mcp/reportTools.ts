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
import type { MonthCaseRow } from "../lib/queries.ts";
import type { PickKind } from "../lib/reportPicks.ts";

export interface ReportDeps {
  /** null 이면 Atlassian 설정이 없다. */
  atlassianConfig: () => AtlassianConfig | null;
  fetchMonthlyWork: (config: AtlassianConfig, month: string) => Promise<WorkResult>;
  loadMonth: (month: string) => Promise<SavedMonth | null>;
  saveMonth: (month: string, input: InstanceInput, previous: PreviousMonth) => Promise<SavedMonth>;
  resolvePrevious: (month: string) => Promise<{ values: PreviousMonth; fromMonth: string | null }>;
  /** 그 달에 등록된 SR. 보고서 2단계의 후보다. */
  listCasesInMonth: (month: string) => Promise<MonthCaseRow[]>;
  /** 선택 조회·저장. 화면(app/report)과 **같은 report_picks 테이블**을 쓴다. */
  loadPicks: (month: string, kind: PickKind) => Promise<string[]>;
  savePicks: (month: string, kind: PickKind, refs: readonly string[]) => Promise<void>;
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
 * 항목 선택
 * ------------------------------------------------------------------ */

export function readKind(value: unknown): PickKind | null {
  return value === "sr" || value === "jira" ? value : null;
}

/**
 * "PA-101, PA-104" 를 목록으로 쪼갠다.
 *
 * 배열이 아니라 쉼표로 이은 문자열로 받는다. 이 파일의 다른 인자와 같은 이유다 —
 * 붙는 쪽 클라이언트가 배열 스키마를 다룬다는 보장이 없다. 줄바꿈으로 붙여 보내는
 * 경우도 있어 함께 받는다. 중복은 순서를 지키며 걷어낸다.
 */
export function parseKeyList(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,\n]/)) {
    const key = part.trim();
    if (key !== "") seen.add(key);
  }
  return [...seen];
}

export interface SelectionArgs {
  keys?: unknown;
  excludeKeys?: unknown;
}

/**
 * keys / excludeKeys 를 실제로 저장할 목록으로 푼다.
 *
 * 있는 것만 저장한다. 모델이 없는 키를 지어내도 조용히 저장하면 빌드에서 그 줄이
 * 사라지는 것으로만 드러난다 — 그래서 모르는 키는 unknown 으로 돌려준다.
 *
 * 결과가 0건이면 거부한다. 빈 선택은 "하나도 안 넣는다" 가 아니라 **선택 없음**으로
 * 읽힌다: lib/pptx.ts 는 Jira 선택이 비면 전부 넣고(정반대다), SR 선택이 비면
 * 빌드를 실패시킨다. 어느 쪽도 사용자가 기대한 결과가 아니다.
 */
export function resolveSelection(
  available: readonly string[],
  args: SelectionArgs,
): { keys: string[]; unknownKeys: string[] } | { message: string } {
  const wanted = parseKeyList(args.keys);
  const excluded = parseKeyList(args.excludeKeys);

  if (wanted.length > 0 && excluded.length > 0) {
    return { message: "keys 와 excludeKeys 중 하나만 주세요." };
  }
  if (wanted.length === 0 && excluded.length === 0) {
    return {
      message:
        "무엇을 넣을지 알려 주세요. 남길 것을 keys 에, 뺄 것을 excludeKeys 에 " +
        '쉼표로 이어 줍니다 (예: excludeKeys="PA-112, PA-130").',
    };
  }

  const have = new Set(available);
  if (wanted.length > 0) {
    const keys = wanted.filter((k) => have.has(k));
    const unknownKeys = wanted.filter((k) => !have.has(k));
    if (keys.length === 0) {
      return {
        message:
          `keys 가 이 달의 목록에 하나도 없습니다: ${unknownKeys.join(", ")}. ` +
          "먼저 목록을 조회해 그 key 를 그대로 주세요.",
      };
    }
    return { keys, unknownKeys };
  }

  const drop = new Set(excluded.filter((k) => have.has(k)));
  const keys = available.filter((k) => !drop.has(k));
  const unknownKeys = excluded.filter((k) => !have.has(k));
  if (keys.length === 0) {
    return { message: "전부 빼면 보고서에 넣을 항목이 없습니다. 최소 한 건은 남겨 주세요." };
  }
  return { keys, unknownKeys };
}

/* ------------------------------------------------------------------ *
 * 도구 핸들러
 * ------------------------------------------------------------------ */

/** 그 달의 작업 진행 현황. 합치기 규칙은 lib/jiraFormat.ts 가 적용한 그대로다. */
export async function getMonthlyWorkHandler(
  deps: ReportDeps,
  args: MonthArgs,
): Promise<
  ReportResult<{
    month: string;
    rows: unknown[];
    skipped: unknown[];
    scanned: number;
    picked: string[];
    pickedNote: string;
  }>
> {
  const parsed = monthKeyOf(args);
  if ("message" in parsed) return { ok: false, message: parsed.message };

  const config = deps.atlassianConfig();
  if (config === null) return { ok: false, message: "Atlassian 설정이 없습니다." };
  if (config.jiraProject === "") {
    return { ok: false, message: "JIRA_PROJECT 가 설정되지 않았습니다." };
  }

  const result = await deps.fetchMonthlyWork(config, parsed.key);
  const picked = await deps.loadPicks(parsed.key, "jira");
  return {
    ok: true,
    month: parsed.key,
    // 전산센터·법인은 합쳐지면 줄바꿈으로 이어져 있다(보고서가 한 칸에 문단을 나눠 쓴다).
    // no 는 사용자가 "3번" 이라고 말할 수 있게 붙이는 **이 응답 한정** 번호다.
    // 저장은 반드시 key 로 한다 — 다음 조회에서 번호는 달라질 수 있다.
    rows: result.rows.map((row, index) => ({ no: index + 1, ...row })),
    // 보고서에서 빠진 이슈와 이유. 왜 안 보이는지 묻는 일이 잦다.
    skipped: result.skipped,
    scanned: result.scanned,
    // 지금 저장된 선택. 비어 있으면 전부 들어간다(화면의 기본값과 같다).
    picked,
    pickedNote: picked.length === 0
      ? "저장된 선택이 없습니다. 이대로 만들면 전부 들어갑니다."
      : `${picked.length}건이 선택돼 있습니다.`,
  };
}

/**
 * 그 달에 등록된 SR 목록. 보고서 2단계의 후보다.
 *
 * Jira 와 달리 **선택이 비면 빌드가 실패한다**(lib/pptx.ts). 그래서 여기서는
 * 고르라고 분명히 말해 준다.
 */
export async function getMonthlyCasesHandler(
  deps: ReportDeps,
  args: MonthArgs,
): Promise<ReportResult<{ month: string; cases: unknown[]; picked: string[]; pickedNote: string }>> {
  const parsed = monthKeyOf(args);
  if ("message" in parsed) return { ok: false, message: parsed.message };

  const cases = await deps.listCasesInMonth(parsed.key);
  const picked = await deps.loadPicks(parsed.key, "sr");
  return {
    ok: true,
    month: parsed.key,
    cases: cases.map((c, index) => ({
      no: index + 1,
      // 저장은 이 key(케이스 번호 문자열)로 한다. 화면도 같은 값을 쓴다.
      key: String(c.request_id),
      label: c.request_id_formatted,
      openedOn: c.created_on,
      subject: c.subject,
      status: c.status,
      product: c.category,
      party: c.party_name,
    })),
    picked,
    pickedNote: picked.length === 0
      ? "아직 고른 SR 이 없습니다. set_report_picks 로 골라야 보고서를 만들 수 있습니다."
      : `${picked.length}건이 선택돼 있습니다.`,
  };
}

/**
 * 보고서에 넣을 항목을 고른다. 화면의 2·3단계와 같은 곳에 저장한다.
 *
 * 채팅에서 고른 것이 화면에 그대로 보이고 반대도 된다 — 같은 report_picks 테이블에
 * 같은 key 를 넣기 때문이다.
 */
export async function setReportPicksHandler(
  deps: ReportDeps,
  args: MonthArgs & SelectionArgs & { kind?: unknown },
): Promise<
  ReportResult<{
    month: string;
    kind: PickKind;
    saved: number;
    keys: string[];
    unknownKeys: string[];
    available: number;
  }>
> {
  const parsed = monthKeyOf(args);
  if ("message" in parsed) return { ok: false, message: parsed.message };
  const month = parsed.key;

  const kind = readKind(args.kind);
  if (kind === null) {
    return { ok: false, message: 'kind 는 "sr"(SR 목록) 또는 "jira"(작업 진행 현황) 입니다.' };
  }

  // 무엇을 고를 수 있는지 먼저 알아야 없는 키를 걸러낼 수 있다.
  let available: string[];
  if (kind === "sr") {
    available = (await deps.listCasesInMonth(month)).map((c) => String(c.request_id));
  } else {
    const config = deps.atlassianConfig();
    if (config === null) return { ok: false, message: "Atlassian 설정이 없습니다." };
    if (config.jiraProject === "") {
      return { ok: false, message: "JIRA_PROJECT 가 설정되지 않았습니다." };
    }
    available = (await deps.fetchMonthlyWork(config, month)).rows.map((r) => r.key);
  }

  if (available.length === 0) {
    return { ok: false, message: `${month} 에는 고를 수 있는 항목이 없습니다.` };
  }

  const resolved = resolveSelection(available, args);
  if ("message" in resolved) return { ok: false, message: resolved.message };

  await deps.savePicks(month, kind, resolved.keys);
  return {
    ok: true,
    month,
    kind,
    saved: resolved.keys.length,
    keys: resolved.keys,
    // 모르는 키는 저장하지 않았다. 챗봇이 사용자에게 되물을 수 있게 돌려준다.
    unknownKeys: resolved.unknownKeys,
    available: available.length,
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
    srPicked: number;
    workPicked: number;
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

  // SR 선택이 비면 빌드가 실패한다(lib/pptx.ts). 여기서 막지 않으면 주소를 받아
  // 열었을 때에야 502 로 드러난다 — 챗봇은 이미 "다 됐습니다" 라고 말한 뒤다.
  const srPicked = await deps.loadPicks(month, "sr");
  if (srPicked.length === 0) {
    return {
      ok: false,
      message:
        `${month} 에 고른 SR 이 없어 보고서를 만들 수 없습니다. ` +
        "get_monthly_cases 로 후보를 보여 주고, set_report_picks(kind=\"sr\") 로 고른 뒤 다시 불러 주세요." +
        (saved !== null ? " (인스턴스 수치는 저장해 두었습니다.)" : ""),
    };
  }

  const workPicked = await deps.loadPicks(month, "jira");
  return {
    ok: true,
    month,
    url: downloadUrl(deps.appUrl, month),
    saved,
    previousFrom,
    srPicked: srPicked.length,
    // 0 이면 그 달 작업이 **전부** 들어간다. 빼고 싶은 것이 있으면 set_report_picks 를 쓴다.
    workPicked: workPicked.length,
    note:
      "이 주소를 열면 보고서가 만들어져 내려받아집니다. " +
      "SR 건수만큼 AI 를 부르므로 몇 분 걸릴 수 있습니다." +
      (workPicked.length === 0 ? " 작업 진행 현황은 선택이 없어 전부 들어갑니다." : ""),
  };
}
