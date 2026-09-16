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

export function loadPicks(month: string, kind: PickKind): string[] {
  const db = openDb();
  try {
    const rows = db
      .prepare("SELECT ref FROM report_picks WHERE month = ? AND kind = ? ORDER BY ord, ref")
      .all(month, kind) as unknown as Array<{ ref: string }>;
    return rows.map((r) => r.ref);
  } finally {
    db.close();
  }
}

/** 그 달·그 종류의 선택을 통째로 갈아끼운다. 빈 배열이면 전부 지운다. */
export function savePicks(month: string, kind: PickKind, refs: readonly string[]): void {
  const db = openDb();
  try {
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM report_picks WHERE month = ? AND kind = ?").run(month, kind);
      const insert = db.prepare(
        "INSERT INTO report_picks (month, kind, ref, ord) VALUES (?,?,?,?)",
      );
      refs.forEach((ref, index) => insert.run(month, kind, ref, index));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

export function countPicks(month: string): { sr: number; jira: number } {
  const db = openDb();
  try {
    const rows = db
      .prepare("SELECT kind, COUNT(*) AS c FROM report_picks WHERE month = ? GROUP BY kind")
      .all(month) as unknown as Array<{ kind: string; c: number }>;
    const map = new Map(rows.map((r) => [r.kind, r.c]));
    return { sr: map.get("sr") ?? 0, jira: map.get("jira") ?? 0 };
  } finally {
    db.close();
  }
}
