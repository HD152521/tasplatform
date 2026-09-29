/**
 * 정기점검 보고서 "01 클라우드 운영 현황" 계산.
 *
 * 원래는 정기점검인스턴스계산.xlsx 의 수식으로 하던 일이다.
 * 수식이 전부 사칙연산이라 옮겨 왔다 — 엑셀 파일 없이 계산된다.
 *
 * 사람이 넣는 값은 9개(법인 3 × 환경 3)뿐이고 나머지는 전부 여기서 나온다.
 *
 *   은행 운영      = (은행운영 + 은행DR) − (공동운영 + 공동DR)
 *   은행 운영(공통) = 공동운영 + 공동DR
 *   은행 개발      = 은행개발 − 공동개발
 *   은행 개발(공통) = 공동개발
 *   중앙회 운영    = 중앙회운영 + 중앙회DR
 *   중앙회 개발    = 중앙회개발
 *
 * 공동 인스턴스는 은행과 중앙회가 반씩 나눠 갖되, 홀수면 은행이 올림,
 * 중앙회가 내림이다. 실 운영 현황은 그 배분을 반영한 값이다.
 *
 * 입력은 소수일 수 있다(App Count 를 그대로 옮겨 적으면 133.4 가 나온다).
 * 반올림은 roundCount 가 계산 입구에서 한 번만 한다 — 이유는 그 함수 주석에 적었다.
 */

/** 사람이 입력하는 9개 값. 소수를 넣어도 되고, 계산 입구에서 정수로 반올림된다. */
export interface InstanceInput {
  /** 은행 */
  bank: EnvCount;
  /** 중앙회 */
  central: EnvCount;
  /** 공동 ORG */
  shared: EnvCount;
}

export interface EnvCount {
  dev: number;
  prod: number;
  dr: number;
}

/**
 * 전월 컨테이너 수. "전월 대비 증감" 계산에만 쓴다.
 * 지난달 보고서를 만들었으면 그 결과가 그대로 이 값이 된다.
 */
export interface PreviousMonth {
  bankProd: number;
  bankProdShared: number;
  bankDev: number;
  bankDevShared: number;
  centralProd: number;
  centralDev: number;
}

/** 클러스터·호스트 수. 계산으로 안 나오는 고정 인프라 값이다. */
export interface InfraRow {
  cluster: number;
  host: number;
  /** 슬라이드에 "24 (12/12)" 처럼 붙는 괄호 표기. 없으면 빈 문자열. */
  clusterNote: string;
  hostNote: string;
}

export interface Infra {
  bankProd: InfraRow;
  bankDev: InfraRow;
  centralProd: InfraRow;
  centralDev: InfraRow;
}

/** 지금 쓰는 값. 인프라가 늘면 여기를 고친다. */
export const DEFAULT_INFRA: Infra = {
  bankProd: { cluster: 24, host: 120, clusterNote: "(12/12)", hostNote: "(60/60)" },
  bankDev: { cluster: 4, host: 16, clusterNote: "", hostNote: "" },
  centralProd: { cluster: 8, host: 36, clusterNote: "(4/4)", hostNote: "(18/18)" },
  centralDev: { cluster: 1, host: 4, clusterNote: "", hostNote: "" },
};

/** 슬라이드 표의 한 행. */
export interface ResultRow {
  /** 첫 칸. 세로 병합되므로 이어지는 행은 빈 문자열이다. */
  entity: string;
  /** 운영 / 운영(공통) / 개발 / 개발(공통) */
  kind: string;
  /** "24 (12/12)" 형태. 공통 행은 비어 있다. */
  cluster: string;
  host: string;
  container: number;
  /** 공통 행의 "은행 : 104 중앙회 : 103" 배분 표기. */
  note: string;
  /** 전월 대비 증감. 클러스터·호스트 증감은 늘 "-" 라 여기 없다. */
  delta: number;
}

export interface InstanceResult {
  rows: ResultRow[];
  total: {
    cluster: number;
    host: number;
    container: number;
    delta: number;
  };
  /** 공동 배분을 반영한 법인별 실 운영 현황. */
  actual: {
    bank: number;
    central: number;
    total: number;
  };
  /** 다음 달 보고서가 전월값으로 쓸 값. 그대로 저장해 두면 된다. */
  carryOver: PreviousMonth;
}

/**
 * 인스턴스 수 하나를 보고서에 들어갈 정수로 만든다. 0.5 는 올린다.
 *
 * ## 왜 하필 계산 입구에서 반올림하나
 *
 * 보고서 표에는 정수만 들어가므로 어딘가에서 한 번은 반올림해야 한다. 고를 수 있는
 * 자리가 셋이었다.
 *
 *   1. 입력을 받는 순간 (app/api/report/instances) — 다음 달에 화면을 다시 열면
 *      자기가 적은 133.4 가 133 으로 바뀌어 있다. 어디서 바뀐 건지 알 수 없고,
 *      App Count 와 맞춰 볼 근거도 사라진다.
 *   2. 보고서를 만들 때만 (lib/pptx.ts) — 화면 표는 1626.4, 보고서 표는 1626 이 된다.
 *      검토하는 사람이 둘 중 무엇이 맞는지 알 수 없다.
 *   3. 계산 입구 = 여기 — 저장은 입력 원본대로 남고(instance_counts 는 REAL),
 *      화면과 보고서는 둘 다 calculateInstances 를 지나므로 같은 정수를 본다.
 *
 * 3번을 골랐다. 덧붙여, 아홉 칸을 먼저 정수로 맞추고 나면 그 뒤가 전부 정수 연산이라
 * 행 합계·전월 대비 증감·공동 배분이 저절로 맞는다. 계산 결과를 행마다 따로
 * 반올림하면 합계가 어긋난다 — 10월 값이 그 예로, 여섯 행의 합은 1627 인데
 * 총합(1626.4)을 따로 반올림하면 1626 이 된다.
 *
 * 파이썬(scripts/build_report.py)에는 이미 정수로 찍은 문자열만 넘어간다.
 * 파이썬 round() 는 은행가 반올림이라 round(136.5) == 136 이다 — 그 경로를
 * 아예 만들지 않는 것이 이 함수가 여기 있는 또 하나의 이유다.
 *
 * 경계(API·MCP)에서 숫자인지 이미 검사하지만, 그래도 unknown 으로 받는다.
 * 표에 NaN 이나 -0 이 찍히는 것보다는 0 이 낫다.
 */
export function roundCount(value: unknown): number {
  // 문자열·null·NaN·Infinity. 여기까지 왔으면 경계 검사가 새어난 것이니 0 으로 막는다.
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  // 음수도 0 이다. 인스턴스가 음수인 달은 없고, Math.round(-0.5) 는 -0 을 낸다.
  if (value <= 0) return 0;
  // 양수에서 Math.round 는 0.5 를 올린다 — 요구사항이 바로 그 규칙이다(사사오입 아님).
  return Math.round(value);
}

function roundEnv(env: EnvCount): EnvCount {
  return { dev: roundCount(env.dev), prod: roundCount(env.prod), dr: roundCount(env.dr) };
}

/** 전월값도 같은 규칙으로 맞춘다. 안 그러면 증감만 소수로 남는다. */
function roundPrevious(previous: PreviousMonth): PreviousMonth {
  return {
    bankProd: roundCount(previous.bankProd),
    bankProdShared: roundCount(previous.bankProdShared),
    bankDev: roundCount(previous.bankDev),
    bankDevShared: roundCount(previous.bankDevShared),
    centralProd: roundCount(previous.centralProd),
    centralDev: roundCount(previous.centralDev),
  };
}

/** 공동 인스턴스 배분: 은행이 올림, 중앙회가 내림. */
function splitShared(shared: number): { bank: number; central: number } {
  return { bank: Math.ceil(shared / 2), central: Math.floor(shared / 2) };
}

function withNote(value: number, note: string): string {
  if (value === 0 && note === "") return "";
  return note === "" ? String(value) : `${value} ${note}`;
}

export function calculateInstances(
  rawInput: InstanceInput,
  rawPrevious: PreviousMonth,
  infra: Infra = DEFAULT_INFRA,
): InstanceResult {
  // 아홉 칸을 먼저 정수로 맞춘다. 이 아래는 전부 정수 연산이므로 행 합계와 증감,
  // 공동 배분이 따로 반올림할 것 없이 맞아떨어진다.
  const input: InstanceInput = {
    bank: roundEnv(rawInput.bank),
    central: roundEnv(rawInput.central),
    shared: roundEnv(rawInput.shared),
  };
  const previous = roundPrevious(rawPrevious);

  const bankProd = input.bank.prod + input.bank.dr - (input.shared.prod + input.shared.dr);
  const bankProdShared = input.shared.prod + input.shared.dr;
  const bankDev = input.bank.dev - input.shared.dev;
  const bankDevShared = input.shared.dev;
  const centralProd = input.central.prod + input.central.dr;
  const centralDev = input.central.dev;

  const prodSplit = splitShared(bankProdShared);
  const devSplit = splitShared(bankDevShared);

  const rows: ResultRow[] = [
    {
      entity: "은행", kind: "운영",
      cluster: withNote(infra.bankProd.cluster, infra.bankProd.clusterNote),
      host: withNote(infra.bankProd.host, infra.bankProd.hostNote),
      container: bankProd, note: "", delta: bankProd - previous.bankProd,
    },
    {
      entity: "", kind: "운영(공통)",
      cluster: "", host: "",
      container: bankProdShared,
      note: `은행 : ${prodSplit.bank}  중앙회 : ${prodSplit.central}`,
      delta: bankProdShared - previous.bankProdShared,
    },
    {
      entity: "", kind: "개발",
      cluster: withNote(infra.bankDev.cluster, infra.bankDev.clusterNote),
      host: withNote(infra.bankDev.host, infra.bankDev.hostNote),
      container: bankDev, note: "", delta: bankDev - previous.bankDev,
    },
    {
      entity: "", kind: "개발(공통)",
      cluster: "", host: "",
      container: bankDevShared,
      note: `은행 : ${devSplit.bank}  중앙회 : ${devSplit.central}`,
      delta: bankDevShared - previous.bankDevShared,
    },
    {
      entity: "중앙회", kind: "운영",
      cluster: withNote(infra.centralProd.cluster, infra.centralProd.clusterNote),
      host: withNote(infra.centralProd.host, infra.centralProd.hostNote),
      container: centralProd, note: "", delta: centralProd - previous.centralProd,
    },
    {
      entity: "", kind: "개발",
      cluster: withNote(infra.centralDev.cluster, infra.centralDev.clusterNote),
      host: withNote(infra.centralDev.host, infra.centralDev.hostNote),
      container: centralDev, note: "", delta: centralDev - previous.centralDev,
    },
  ];

  const container = bankProd + bankProdShared + bankDev + bankDevShared + centralProd + centralDev;
  const previousTotal =
    previous.bankProd + previous.bankProdShared + previous.bankDev
    + previous.bankDevShared + previous.centralProd + previous.centralDev;

  // 공통 인스턴스 중 중앙회 몫을 은행에서 떼어 중앙회로 옮긴다.
  const toCentral = prodSplit.central + devSplit.central;
  const actualBank = bankProd + bankProdShared + bankDev + bankDevShared - toCentral;
  const actualCentral = centralProd + centralDev + toCentral;

  return {
    rows,
    total: {
      cluster: infra.bankProd.cluster + infra.bankDev.cluster
        + infra.centralProd.cluster + infra.centralDev.cluster,
      host: infra.bankProd.host + infra.bankDev.host
        + infra.centralProd.host + infra.centralDev.host,
      container,
      delta: container - previousTotal,
    },
    actual: { bank: actualBank, central: actualCentral, total: actualBank + actualCentral },
    carryOver: { bankProd, bankProdShared, bankDev, bankDevShared, centralProd, centralDev },
  };
}

/** 입력이 없을 때 쓰는 0값. 첫 달에는 전월값이 없다. */
export const EMPTY_PREVIOUS: PreviousMonth = {
  bankProd: 0, bankProdShared: 0, bankDev: 0,
  bankDevShared: 0, centralProd: 0, centralDev: 0,
};
