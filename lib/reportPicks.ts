/**
 * 정기점검 보고서에 넣을 항목 선택 저장.
 *
 * 단계를 오가도 고른 것이 남아야 해서 DB 에 둔다.
 * kind 'sr' 은 케이스 번호, 'jira' 는 이슈 키다.
 */
import "server-only";
import { openDb } from "./db.ts";

export type PickKind = "sr" | "jira";

export function isPickKind(value: unknown): value is PickKind {
  return value === "sr" || value === "jira";
}

export async function loadPicks(month: string, kind: PickKind): Promise<string[]> {
  const db = await openDb();
  try {
    const rows = (await db.all(
      "SELECT ref FROM report_picks WHERE month = ? AND kind = ? ORDER BY ord, ref",
      [month, kind],
    )) as Array<{ ref: string }>;
    return rows.map((r) => r.ref);
  } finally {
    await db.close();
  }
}

/** 그 달·그 종류의 선택을 통째로 갈아끼운다. 빈 배열이면 전부 지운다. */
export async function savePicks(month: string, kind: PickKind, refs: readonly string[]): Promise<void> {
  const db = await openDb();
  try {
    await db.tx(async (tx) => {
      await tx.run("DELETE FROM report_picks WHERE month = ? AND kind = ?", [month, kind]);
      for (const [index, ref] of refs.entries()) {
        await tx.run(
          "INSERT INTO report_picks (month, kind, ref, ord) VALUES (?,?,?,?)",
          [month, kind, ref, index],
        );
      }
    });
  } finally {
    await db.close();
  }
}

export async function countPicks(month: string): Promise<{ sr: number; jira: number }> {
  const db = await openDb();
  try {
    const rows = (await db.all(
      "SELECT kind, COUNT(*) AS c FROM report_picks WHERE month = ? GROUP BY kind",
      [month],
    )) as Array<{ kind: string; c: number }>;
    const map = new Map(rows.map((r) => [r.kind, Number(r.c)]));
    return { sr: map.get("sr") ?? 0, jira: map.get("jira") ?? 0 };
  } finally {
    await db.close();
  }
}
