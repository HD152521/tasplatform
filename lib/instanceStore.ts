/**
 * 월별 인스턴스 입력값 저장.
 *
 * 저장해 두는 이유는 다음 달 "전월 대비 증감" 때문이다. 지난달 결과가 있으면
 * 이번 달에는 입력 9개만 넣으면 된다. 첫 달에만 전월값을 직접 넣는다.
 *
 * lib/summary.ts 와 같이 읽기·쓰기를 한 모듈에서 처리한다.
 */
import "server-only";
import { openDb } from "./db.ts";
import { isoNow } from "./dates.ts";
import { EMPTY_PREVIOUS, calculateInstances } from "./instanceCount.ts";
import type { InstanceInput, PreviousMonth } from "./instanceCount.ts";

export interface SavedMonth {
  month: string;
  input: InstanceInput;
  /** 이 달의 계산 결과. 다음 달이 전월값으로 쓴다. */
  containers: PreviousMonth;
  /** 이 달을 계산할 때 쓴 전월값. 첫 달이면 사람이 넣은 값이다. */
  previous: PreviousMonth;
  savedAt: string;
}

interface Row {
  month: string;
  bank_dev: number; bank_prod: number; bank_dr: number;
  central_dev: number; central_prod: number; central_dr: number;
  shared_dev: number; shared_prod: number; shared_dr: number;
  container_bank_prod: number; container_bank_prod_shared: number;
  container_bank_dev: number; container_bank_dev_shared: number;
  container_central_prod: number; container_central_dev: number;
  prev_bank_prod: number; prev_bank_prod_shared: number;
  prev_bank_dev: number; prev_bank_dev_shared: number;
  prev_central_prod: number; prev_central_dev: number;
  saved_at: string;
}

function toSaved(row: Row): SavedMonth {
  return {
    month: row.month,
    input: {
      bank: { dev: row.bank_dev, prod: row.bank_prod, dr: row.bank_dr },
      central: { dev: row.central_dev, prod: row.central_prod, dr: row.central_dr },
      shared: { dev: row.shared_dev, prod: row.shared_prod, dr: row.shared_dr },
    },
    containers: {
      bankProd: row.container_bank_prod,
      bankProdShared: row.container_bank_prod_shared,
      bankDev: row.container_bank_dev,
      bankDevShared: row.container_bank_dev_shared,
      centralProd: row.container_central_prod,
      centralDev: row.container_central_dev,
    },
    previous: {
      bankProd: row.prev_bank_prod,
      bankProdShared: row.prev_bank_prod_shared,
      bankDev: row.prev_bank_dev,
      bankDevShared: row.prev_bank_dev_shared,
      centralProd: row.prev_central_prod,
      centralDev: row.prev_central_dev,
    },
    savedAt: row.saved_at,
  };
}

/** 'YYYY-MM' 인지 확인한다. 화면에서 넘어온 값을 그대로 쿼리에 넣지 않기 위함이다. */
export function isMonth(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** 'YYYY-MM' 의 직전 달. */
export function previousMonthOf(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  return `${d.y}-${String(d.m).padStart(2, "0")}`;
}

export function loadMonth(month: string): SavedMonth | null {
  const db = openDb();
  try {
    const rows = db
      .prepare("SELECT * FROM instance_counts WHERE month = ?")
      .all(month) as unknown as Row[];
    const row = rows[0];
    return row === undefined ? null : toSaved(row);
  } finally {
    db.close();
  }
}

/**
 * 전월값을 찾는다.
 *
 * 직전 달이 없으면 그보다 앞선 달 중 가장 최근 것을 쓴다 — 한 달 건너뛰었다고
 * 증감이 통째로 틀리는 것보다는 낫다. 화면에서 어느 달을 썼는지 보여준다.
 */
export function findPrevious(month: string): SavedMonth | null {
  const db = openDb();
  try {
    const rows = db
      .prepare("SELECT * FROM instance_counts WHERE month < ? ORDER BY month DESC LIMIT 1")
      .all(month) as unknown as Row[];
    const row = rows[0];
    return row === undefined ? null : toSaved(row);
  } finally {
    db.close();
  }
}

export function listMonths(): Array<{ month: string; savedAt: string }> {
  const db = openDb();
  try {
    const rows = db
      .prepare("SELECT month, saved_at FROM instance_counts ORDER BY month DESC")
      .all() as unknown as Array<{ month: string; saved_at: string }>;
    return rows.map((r) => ({ month: r.month, savedAt: r.saved_at }));
  } finally {
    db.close();
  }
}

/** 입력값과 계산 결과를 함께 저장한다. 같은 달을 다시 저장하면 덮어쓴다. */
export function saveMonth(month: string, input: InstanceInput, previous: PreviousMonth): SavedMonth {
  const { carryOver } = calculateInstances(input, previous);
  const savedAt = isoNow();
  const db = openDb();
  try {
    db.prepare(
      `INSERT INTO instance_counts (
         month, bank_dev, bank_prod, bank_dr,
         central_dev, central_prod, central_dr,
         shared_dev, shared_prod, shared_dr,
         container_bank_prod, container_bank_prod_shared,
         container_bank_dev, container_bank_dev_shared,
         container_central_prod, container_central_dev,
         prev_bank_prod, prev_bank_prod_shared,
         prev_bank_dev, prev_bank_dev_shared,
         prev_central_prod, prev_central_dev, saved_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(month) DO UPDATE SET
         bank_dev = excluded.bank_dev, bank_prod = excluded.bank_prod, bank_dr = excluded.bank_dr,
         central_dev = excluded.central_dev, central_prod = excluded.central_prod,
         central_dr = excluded.central_dr,
         shared_dev = excluded.shared_dev, shared_prod = excluded.shared_prod,
         shared_dr = excluded.shared_dr,
         container_bank_prod = excluded.container_bank_prod,
         container_bank_prod_shared = excluded.container_bank_prod_shared,
         container_bank_dev = excluded.container_bank_dev,
         container_bank_dev_shared = excluded.container_bank_dev_shared,
         container_central_prod = excluded.container_central_prod,
         container_central_dev = excluded.container_central_dev,
         prev_bank_prod = excluded.prev_bank_prod,
         prev_bank_prod_shared = excluded.prev_bank_prod_shared,
         prev_bank_dev = excluded.prev_bank_dev,
         prev_bank_dev_shared = excluded.prev_bank_dev_shared,
         prev_central_prod = excluded.prev_central_prod,
         prev_central_dev = excluded.prev_central_dev,
         saved_at = excluded.saved_at`,
    ).run(
      month, input.bank.dev, input.bank.prod, input.bank.dr,
      input.central.dev, input.central.prod, input.central.dr,
      input.shared.dev, input.shared.prod, input.shared.dr,
      carryOver.bankProd, carryOver.bankProdShared,
      carryOver.bankDev, carryOver.bankDevShared,
      carryOver.centralProd, carryOver.centralDev,
      previous.bankProd, previous.bankProdShared,
      previous.bankDev, previous.bankDevShared,
      previous.centralProd, previous.centralDev, savedAt,
    );
  } finally {
    db.close();
  }
  return { month, input, containers: carryOver, previous, savedAt };
}

/**
 * 이 달을 계산할 때 쓸 전월값을 정한다.
 *
 * 앞선 달이 저장돼 있으면 그 결과를 쓴다 (사람이 손댈 일 없음).
 * 없으면 이 달에 저장해 둔 값을 되살린다 — 첫 달에 직접 넣은 값이다.
 */
export function resolvePrevious(month: string): {
  values: PreviousMonth;
  /** 값을 가져온 달. null 이면 사람이 입력해야 한다. */
  fromMonth: string | null;
} {
  const earlier = findPrevious(month);
  if (earlier !== null) return { values: earlier.containers, fromMonth: earlier.month };

  const own = loadMonth(month);
  return { values: own?.previous ?? EMPTY_PREVIOUS, fromMonth: null };
}
