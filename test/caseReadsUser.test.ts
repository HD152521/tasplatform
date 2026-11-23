/**
 * 케이스 "읽음" 은 **사람마다**다.
 *
 * 전에는 case_reads 가 팀 공유였다(request_id 하나가 기본키). 한 사람이 열면 모두의
 * '새 답변' 배지가 사라져서, 다른 사람은 그 답변을 못 보고 지나갔다. 사람이 생긴
 * 뒤에는 그 칸이 사람마다 있어야 한다.
 *
 * 동시에, 바꾸는 날 **미읽음 숫자가 치솟으면 안 된다.** 이미 팀이 읽어 둔 것은 모두에게
 * 읽은 상태로 남아야 한다 — 그래서 옛 표를 지우지 않고 바닥값으로 읽는다
 * (lib/schema.ts case_reads_user 머리말). 이 두 가지가 서로 모순처럼 보이므로
 * 시험으로 못박는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../lib/db.ts";
import { listCases, markCaseRead } from "../lib/queries.ts";

const ANNA = 1;
const BORA = 2;

/** 상대 답변이 하나 달린 케이스 한 건을 넣는다. 답변 시각은 1000ms. */
async function seed(dbFile: string, teamId = "default"): Promise<void> {
  const db = await openDb(dbFile);
  try {
    await db.run(
      `INSERT INTO cases (request_id, request_id_formatted, subject, status, priority,
         category, party_name, created_on, created_on_ms, last_updated, last_updated_ms,
         description_text, description_html, case_version, team_id, first_seen_at, last_fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [7, "7", "제목", "Open", "P3", "cat", "고객사", "2026-11-01", 1, "2026-11-02", 2, "", "", 1, teamId,
       "2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z"],
    );
    await db.run(
      `INSERT INTO threads (thread_id, request_id, is_ours, author_unit, res_date_val, res_date_ms, body_text, body_html, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [1, 7, 0, "Broadcom", "2026-11-02", 1000, "답변", "", "2026-11-02T00:00:00.000Z"],
    );
  } finally {
    await db.close();
  }
}

async function withTempDb(run: (dbFile: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "reads-"));
  const dbFile = join(dir, "sr.db");
  // markCaseRead 는 dbFile 을 받지 않고 기본 경로를 연다. 환경변수로 임시 DB 를 가리킨다.
  const saved = { file: process.env.SR_DB_FILE, url: process.env.DATABASE_URL };
  delete process.env.DATABASE_URL;
  process.env.SR_DB_FILE = dbFile;
  try {
    await run(dbFile);
  } finally {
    if (saved.file !== undefined) process.env.SR_DB_FILE = saved.file;
    else delete process.env.SR_DB_FILE;
    if (saved.url !== undefined) process.env.DATABASE_URL = saved.url;
    rmSync(dir, { recursive: true, force: true });
  }
}

async function unreadFor(userId: number, dbFile: string): Promise<number> {
  const rows = await listCases({ userId, dbFile });
  return rows[0]?.unread_replies ?? 0;
}

test("아무도 안 읽었으면 두 사람 모두 미읽음 1", async () => {
  await withTempDb(async (dbFile) => {
    await seed(dbFile);
    assert.equal(await unreadFor(ANNA, dbFile), 1);
    assert.equal(await unreadFor(BORA, dbFile), 1);
  });
});

// 이것이 이 변경의 핵심이다. 전에는 보라의 배지도 같이 사라졌다.
test("안나가 읽어도 보라에게는 여전히 미읽음이다", async () => {
  await withTempDb(async (dbFile) => {
    await seed(dbFile);
    await markCaseRead(7, ANNA);

    assert.equal(await unreadFor(ANNA, dbFile), 0, "읽은 사람은 0");
    assert.equal(await unreadFor(BORA, dbFile), 1, "안 읽은 사람은 그대로 1");
  });
});

// 바꾸는 날 미읽음이 치솟지 않아야 한다 — 옛 팀 공유 기록이 모두의 바닥값이 된다.
test("옛 팀 공유 기록은 모두에게 읽은 것으로 남는다", async () => {
  await withTempDb(async (dbFile) => {
    await seed(dbFile);
    const db = await openDb(dbFile);
    try {
      // 사용자별로 바꾸기 전에 팀이 읽어 둔 상태를 재현한다.
      await db.run(
        "INSERT INTO case_reads (request_id, last_read_thread_ms, read_at) VALUES (?, ?, ?)",
        [7, 1000, "2026-11-20T00:00:00.000Z"],
      );
    } finally {
      await db.close();
    }

    assert.equal(await unreadFor(ANNA, dbFile), 0);
    assert.equal(await unreadFor(BORA, dbFile), 0);
  });
});

// 바닥값이 천장이 되면 안 된다 — 그 뒤에 온 답변은 사람마다 다시 센다.
test("옛 기록 이후에 온 답변은 사람마다 따로 센다", async () => {
  await withTempDb(async (dbFile) => {
    await seed(dbFile);
    const db = await openDb(dbFile);
    try {
      await db.run(
        "INSERT INTO case_reads (request_id, last_read_thread_ms, read_at) VALUES (?, ?, ?)",
        [7, 1000, "2026-11-20T00:00:00.000Z"],
      );
      // 옛 기록보다 **새로운** 상대 답변.
      await db.run(
        `INSERT INTO threads (thread_id, request_id, is_ours, author_unit, res_date_val, res_date_ms, body_text, body_html, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [2, 7, 0, "Broadcom", "2026-11-22", 2000, "새 답변", "", "2026-11-22T00:00:00.000Z"],
      );
    } finally {
      await db.close();
    }

    assert.equal(await unreadFor(ANNA, dbFile), 1, "둘 다 새 답변은 못 봤다");
    assert.equal(await unreadFor(BORA, dbFile), 1);

    await markCaseRead(7, ANNA);
    assert.equal(await unreadFor(ANNA, dbFile), 0);
    assert.equal(await unreadFor(BORA, dbFile), 1, "보라는 그대로 1");
  });
});

// 로그인 없이 부르는 경로(MCP·스크립트)가 옛 팀 기록을 더럽히면 안 된다.
test("userId 가 없으면 아무것도 적지 않는다", async () => {
  await withTempDb(async (dbFile) => {
    await seed(dbFile);
    await markCaseRead(7, 0);

    const db = await openDb(dbFile);
    try {
      const mine = await db.all("SELECT * FROM case_reads_user");
      const legacy = await db.all("SELECT * FROM case_reads");
      assert.equal(mine.length, 0, "사용자 표에 안 적힌다");
      assert.equal(legacy.length, 0, "옛 팀 공유 표에도 안 적힌다");
    } finally {
      await db.close();
    }
  });
});

// 팀 필터와 미읽음 식이 같은 쿼리에 있다 — 파라미터 순서가 틀리면 조용히 어긋난다.
test("다른 팀 케이스는 목록에 끼지 않는다", async () => {
  await withTempDb(async (dbFile) => {
    await seed(dbFile, "team-aaaa");

    assert.equal((await listCases({ teamId: "team-aaaa", userId: ANNA, dbFile })).length, 1);
    assert.equal((await listCases({ teamId: "team-bbbb", userId: ANNA, dbFile })).length, 0);
    // 팀을 주면서도 미읽음은 그 사람 기준이어야 한다(파라미터 순서 확인).
    const rows = await listCases({ teamId: "team-aaaa", userId: ANNA, dbFile });
    assert.equal(rows[0]?.unread_replies, 1);
    await markCaseRead(7, ANNA);
    const after = await listCases({ teamId: "team-aaaa", userId: ANNA, dbFile });
    assert.equal(after[0]?.unread_replies, 0);
  });
});
