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
 */

/** 사람이 입력하는 9개 값. */
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

/** 공동 인스턴스 배분: 은행이 올림, 중앙회가 내림. */
function splitShared(shared: number): { bank: number; central: number } {
  return { bank: Math.ceil(shared / 2), central: Math.floor(shared / 2) };
}

function withNote(value: number, note: string): string {
  if (value === 0 && note === "") return "";
  return note === "" ? String(value) : `${value} ${note}`;
}

export function calculateInstances(
  input: InstanceInput,
  previous: PreviousMonth,
  infra: Infra = DEFAULT_INFRA,
): InstanceResult {
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
