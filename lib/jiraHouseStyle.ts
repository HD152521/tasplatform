/**
 * 이 팀이 Jira 에 실제로 쓰는 양식.
 *
 * ## 어떻게 알아냈나 — 추측이 아니다
 *
 * NHTAS 프로젝트의 이슈 370건을 조회해 **빈도를 집계**했다(2026-11-20). 규칙이 셋으로
 * 갈려 있다는 것이 요점이다. 하나라도 엉뚱하게 넣으면 보고서 집계(lib/jira.ts)가
 * 그 건을 놓치거나 다른 법인으로 센다.
 *
 *   1) 제목 앞 대괄호 = **전산망/센터**
 *        운영 116 · 개발 92 · 본사 91 · DR 45 · AWS 37 · 검증 17 · 은행 4 · 안성 2
 *        여럿이면 `/` 로 잇는다: `[운영/DR]` 13, `[개발/운영/DR]` 5, `[개발/운영/DR/AWS]` 4
 *        대괄호가 아예 없는 건도 13건 있다(규칙 밖).
 *   2) 법인 = **상위 에픽**
 *        NH은행 운영지원 193 · NH본사 지원 81 · NH중앙회 운영지원 49
 *        lib/jira.ts 가 이 에픽 이름으로 법인을 읽는다(readCorp).
 *   3) 업무 성격 = **라벨**
 *        TAS_작업지원 248 · TAS_내부업무 35 · TAS_SR 23 · TAS_장애대응 18
 *
 * 이슈 타입은 `작업` 337건이 압도적이다(하위 작업 28·에픽 3·SR오픈 2).
 *
 * ## 본사가 망이면서 법인인 것
 *
 * `[본사]` 가 91건으로 세 번째로 많은데, 본사는 **법인**이기도 하다(에픽 NH본사 지원).
 * 즉 본사 일은 망 자리에 본사를 적는 관행이다. 그래서 망을 따로 적지 않고 법인만
 * 본사면 대괄호에 `본사` 를 넣는다 — 그게 기존 91건과 같은 모양이다.
 *
 * ## 순서를 고정하는 이유
 *
 * 같은 조합이 `[개발/운영/DR]`(5)과 `[운영/개발/DR]`(1)로 갈려 있다. 사람이 적는 대로
 * 두면 같은 작업이 두 모양으로 남아 눈으로 묶이지 않는다. 더 흔한 쪽(개발→운영→DR→AWS)
 * 으로 **정렬해 적는다.**
 *
 * 순수 함수만 둔다 — 네트워크도 DB 도 모른다. 그래서 시험으로 전부 잠근다.
 */

/** 제목 앞 대괄호에 들어가는 값. 위 집계에서 나온 것 전부. */
export const SCOPES = ["개발", "운영", "DR", "AWS", "검증", "본사", "안성"] as const;
export type Scope = (typeof SCOPES)[number];

/**
 * 대괄호 안에 적는 순서. 흔한 쪽을 따른다(`[개발/운영/DR/AWS]` 4건 vs 역순 1건).
 * 본사·검증·안성은 단독으로 쓰이는 일이 많아 뒤에 둔다.
 */
const SCOPE_ORDER: readonly Scope[] = ["개발", "운영", "DR", "AWS", "검증", "안성", "본사"];

/** 법인. 상위 에픽으로 갈린다. */
export const CORPS = ["은행", "중앙회", "본사"] as const;
export type Corp = (typeof CORPS)[number];

/**
 * 태그 → 망. 사용자가 줄여 쓰는 말까지 받는다.
 *
 * 대소문자를 접는다(`aws`·`AWS`·`Aws` 가 모두 같은 것이다). `dr` 도 마찬가지.
 */
const SCOPE_ALIASES: ReadonlyMap<string, Scope> = new Map([
  ["개발", "개발"], ["개", "개발"], ["dev", "개발"],
  ["운영", "운영"], ["운", "운영"], ["prod", "운영"], ["prd", "운영"],
  ["dr", "DR"], ["재해복구", "DR"],
  ["aws", "AWS"], ["클라우드", "AWS"],
  ["검증", "검증"], ["검", "검증"],
  ["본사", "본사"], ["본", "본사"],
  ["안성", "안성"],
]);

/**
 * 태그 → 법인. `은=은행 중=중앙회` 는 이 팀이 쓰는 줄임말이다.
 *
 * **중앙회를 은행보다 먼저 보지 않아도 된다** — 여기는 완전일치 표라 "중앙회" 가
 * "은행" 에 걸릴 일이 없다. (lib/jira.ts 의 readCorp 는 에픽 **이름** 안에서 찾기
 * 때문에 순서가 중요하다. 둘은 다른 문제다.)
 */
const CORP_ALIASES: ReadonlyMap<string, Corp> = new Map([
  ["은행", "은행"], ["은", "은행"], ["nh은행", "은행"], ["bank", "은행"],
  ["중앙회", "중앙회"], ["중", "중앙회"], ["nh중앙회", "중앙회"],
  ["본사", "본사"], ["본", "본사"], ["nh본사", "본사"],
]);

function norm(tag: string): string {
  return tag.trim().toLowerCase();
}

export function readScope(tag: string): Scope | null {
  return SCOPE_ALIASES.get(norm(tag)) ?? null;
}

export function readCorpTag(tag: string): Corp | null {
  return CORP_ALIASES.get(norm(tag)) ?? null;
}

/** 업무 성격 라벨. 집계에서 실제로 쓰이는 넷 중 캘린더가 쓸 셋. */
export const WORK_LABELS = {
  support: "TAS_작업지원",
  incident: "TAS_장애대응",
  internal: "TAS_내부업무",
} as const;

/**
 * 업무 성격 태그 → 라벨. 모르는 태그는 기본값(작업지원)이다 — 248건이 그것이다.
 *
 * 라벨을 **틀리게 붙이는 것보다 기본값이 안전하다.** 장애대응으로 잘못 붙으면
 * 장애 집계가 부풀고, 그 숫자는 보고서에 그대로 올라간다.
 */
export function readWorkLabel(tags: readonly string[]): string {
  for (const tag of tags) {
    const t = norm(tag);
    if (t === "장애" || t === "장애대응" || t === "incident") return WORK_LABELS.incident;
    if (t === "내부" || t === "내부업무" || t === "회의" || t === "교육" || t === "문서") {
      return WORK_LABELS.internal;
    }
  }
  return WORK_LABELS.support;
}

export interface ClassifiedTags {
  /** 제목 대괄호에 들어갈 망. 정해진 순서로 정렬돼 있다. */
  readonly scopes: readonly Scope[];
  /** 상위 에픽을 고르는 법인. 없으면 null. */
  readonly corp: Corp | null;
  /** 망·법인으로 읽히지 않은 태그. 업무 성격(점검·작업·장애…)으로 남는다. */
  readonly rest: readonly string[];
}

/**
 * `#태그` 들을 망 / 법인 / 나머지로 가른다.
 *
 * 하나의 태그가 둘로 읽힐 수 있다 — `본사` 는 망이면서 법인이다. 그때는 **둘 다**로
 * 기록한다(대괄호에 본사, 에픽도 본사). 그게 기존 91건의 모양이다.
 */
export function classifyTags(tags: readonly string[]): ClassifiedTags {
  const scopes: Scope[] = [];
  let corp: Corp | null = null;
  const rest: string[] = [];

  for (const tag of tags) {
    const scope = readScope(tag);
    const asCorp = readCorpTag(tag);

    if (scope !== null && !scopes.includes(scope)) scopes.push(scope);
    // 법인은 **처음 적은 것**을 쓴다. 두 법인을 함께 적는 일은 양식에 없다.
    if (asCorp !== null && corp === null) corp = asCorp;
    if (scope === null && asCorp === null) rest.push(tag);
  }

  return { scopes: sortScopes(scopes), corp, rest };
}

export function sortScopes(scopes: readonly Scope[]): Scope[] {
  return [...scopes].sort((a, b) => SCOPE_ORDER.indexOf(a) - SCOPE_ORDER.indexOf(b));
}

/**
 * 사내 양식의 제목.
 *
 *   {scopes:["개발","운영"], title:"정기 점검"}  → "[개발/운영] 정기 점검"
 *   {scopes:[], corp:"본사", title:"문서 작성"}   → "[본사] 문서 작성"
 *   {scopes:[], corp:null, title:"ASG 테스트"}    → "ASG 테스트"   (대괄호 없는 13건과 같다)
 *
 * 망이 비고 법인이 본사일 때만 대괄호에 본사를 넣는다 — 은행·중앙회는 에픽이
 * 말해 주므로 제목에 넣지 않는다(실제로 `[은행]` 은 4건뿐이다).
 */
export function houseSummary(input: {
  scopes: readonly Scope[];
  corp?: Corp | null;
  title: string;
}): string {
  const title = input.title.trim();
  const scopes = sortScopes(input.scopes);
  const bracket =
    scopes.length > 0
      ? scopes.join("/")
      : input.corp === "본사"
        ? "본사"
        : "";
  return bracket === "" ? title : `[${bracket}] ${title}`;
}

/**
 * 법인별 상위 에픽 키.
 *
 * 값을 코드에 박지 않는다 — 이 저장소는 공개이고, 에픽 키는 이 인스턴스의 값이다
 * (lib/jiraWrite.ts 의 JIRA_SR_EPIC 주석과 같은 이유). 설정이 없으면 기존
 * `JIRA_SR_EPIC` 으로 떨어진다 — 그러면 전부 한 에픽에 달리지만, **이슈가 아예
 * 안 만들어지는 것보다 낫다.** 어느 쪽으로 떨어졌는지는 부르는 쪽이 알 수 있다.
 */
export function corpEpicKey(corp: Corp | null): { key: string; exact: boolean } {
  const env = (name: string): string => (process.env[name] ?? "").trim();
  const fallback = env("JIRA_SR_EPIC");

  if (corp === null) return { key: fallback, exact: false };
  const byCorp = {
    은행: env("JIRA_EPIC_BANK"),
    중앙회: env("JIRA_EPIC_CENTRAL"),
    본사: env("JIRA_EPIC_HQ"),
  }[corp];

  return byCorp === "" ? { key: fallback, exact: false } : { key: byCorp, exact: true };
}

/** 사람이 읽을 분류 요약. 미리보기와 일정 상세가 쓴다. */
export function describeClassification(c: ClassifiedTags): string {
  const parts: string[] = [];
  if (c.scopes.length > 0) parts.push(`망 ${c.scopes.join("/")}`);
  if (c.corp !== null) parts.push(`법인 ${c.corp}`);
  const label = readWorkLabel(c.rest);
  parts.push(label.replace(/^TAS_/, ""));
  return parts.join(" · ");
}

/* ------------------------------------------------------------------ *
 * 본문 양식
 * ------------------------------------------------------------------ */

/**
 * 본문도 추측이 아니다 — NHTAS 최근 80건을 조회해 모양을 셌다(2026-11-24).
 *
 *   본문이 있는 건 **80 / 80.** 빈칸은 우리가 올린 것뿐이었다.
 *   모양: 짧은 줄의 나열 75 · `라벨: 값` 3 · 번호 절 2
 *
 * 첫 줄은 "무엇을" 이고 **법인·망을 글로 앞세우는** 관행이 뚜렷하다 —
 *   `은행 운영 GSLB전환 모니터링` · `중앙회 bbr 백업 테스트 지원` · `검증 opsmanager 업그레이드 작업`
 * 제목 대괄호와 겹치지만 팀도 그렇게 쓴다(제목과 본문 첫 줄이 거의 같은 건도 있다).
 * 시각은 짧은 줄로 따로 적고(`08:00~`, `09:00~04:00`), 회의는 `일시:` 라벨을 쓴다.
 * 결과는 화살표로 잇는다(`원인 불명 → 추가 지연 없어 모니터링 해제`).
 *
 * 반대로 **메타데이터를 라벨로 줄줄이 나열하는 건은 80건 중 하나도 없다.** 망은 제목
 * 대괄호, 법인은 상위 에픽, 성격은 라벨이 이미 말한다. 같은 것을 네 번 적으면 사람이
 * 읽어야 할 줄이 그만큼 뒤로 밀린다. 그래서 본문에서 뺀다.
 */
export function houseHeadLine(input: {
  readonly scopes: readonly Scope[];
  readonly corp?: Corp | null;
  readonly title: string;
}): string {
  const scopes = sortScopes(input.scopes);
  // 본사는 망이면서 법인이다. 둘 다 적으면 "본사 본사" 가 된다.
  const corp = input.corp !== null && input.corp !== undefined && !scopes.includes(input.corp as Scope)
    ? input.corp
    : "";
  return [corp, scopes.join("/"), input.title.trim()].filter((part) => part !== "").join(" ");
}

/**
 * 일시 한 줄. 날짜 칸이 떨어져도 본문에는 남아야 한다.
 *
 * 시작일·duedate 는 곁가지 칸(extras)이라 400 한 번에 떨어질 수 있다. 그러면 언제 하는
 * 일인지가 **아무 데도** 남지 않는다. 그래서 본문에 한 줄 적는다 — 팀의 회의 이슈가
 * 쓰는 `일시:` 라벨을 그대로 쓴다.
 *
 * 종일이면 시각을 적지 않는다(팀도 종일 건에는 시각 줄이 없다).
 */
export function houseWhenLine(input: {
  readonly startDate: string;
  readonly endDate: string;
  readonly startTime: string;
  readonly endTime: string;
}): string {
  const days =
    input.endDate === "" || input.endDate === input.startDate
      ? input.startDate
      : `${input.startDate} ~ ${input.endDate}`;
  if (days === "") return "";

  const time =
    input.startTime === ""
      ? ""
      : input.endTime === ""
        ? `${input.startTime}~`
        : `${input.startTime}~${input.endTime}`;
  return time === "" ? `일시: ${days} (종일)` : `일시: ${days} ${time}`;
}
