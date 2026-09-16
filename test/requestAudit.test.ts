/**
 * lib/requestAudit.ts 단위테스트.
 *
 * app/api/reply, app/api/create 라우트는 lib/reply.ts·lib/createCase.ts(server-only)를
 * 걸쳐 부르기 때문에 node --test 에서 라우트 핸들러를 직접 못 불러온다(실측 확인).
 * 그래서 두 라우트가 공통으로 쓰는 이 헬퍼(actor/team 뽑기 + 감사 로그 기록)를
 * 직접 단위테스트한다. 라우트는 이 헬퍼를 실제로 호출한다(app/api/reply/route.ts,
 * app/api/create/route.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_TEAM_ID, sessionFileForTeam } from "../lib/config.ts";
import { listAudit, openDb } from "../lib/db.ts";
import {
  hasTeamSession, recordWriteAudit, resolveActorTeam, runSideEffect,
} from "../lib/requestAudit.ts";

function tempDbFile() {
  const dir = mkdtempSync(join(tmpdir(), "srhub-audit-"));
  const file = join(dir, "test.db");
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── resolveActorTeam ────────────────────────────────────────────────

test("actor/team 이 둘 다 오면 다듬어서 그대로 쓴다", () => {
  const result = resolveActorTeam({ actor: " alice ", team: "acme" });
  assert.deepEqual(result, { ok: true, actor: "alice", teamId: "acme" });
});

test("actor/team 을 생략하면 기본 팀·빈 actor 로 처리한다 (하위호환)", () => {
  const result = resolveActorTeam({});
  assert.deepEqual(result, { ok: true, actor: "", teamId: DEFAULT_TEAM_ID });
});

test("team 이 빈 문자열이어도 기본 팀으로 처리한다", () => {
  const result = resolveActorTeam({ team: "   " });
  assert.equal(result.ok, true);
  assert.equal((result as { teamId: string }).teamId, DEFAULT_TEAM_ID);
});

test("actor/team 이 문자열이 아니면(잘못된 타입) 미제공과 동일하게 처리한다", () => {
  const result = resolveActorTeam({ actor: 123 as unknown, team: { x: 1 } as unknown });
  assert.deepEqual(result, { ok: true, actor: "", teamId: DEFAULT_TEAM_ID });
});

test("형식이 잘못된 team id 는 거부하고 사유를 돌려준다 (400 대상)", () => {
  const result = resolveActorTeam({ team: "a/b" });
  assert.equal(result.ok, false);
  assert.ok((result as { message: string }).message.length > 0);
});

test("경로 탈출을 노리는 team id 도 거부한다", () => {
  const result = resolveActorTeam({ team: "../x" });
  assert.equal(result.ok, false);
});

// ── recordWriteAudit ────────────────────────────────────────────────

test("성공 기록: actor·team·action·result=ok 가 남는다", async () => {
  const { file, cleanup } = tempDbFile();
  try {
    await recordWriteAudit(
      { actor: "alice", teamId: "acme", action: "reply", requestId: 37074096, result: "ok" },
      file,
    );
    const db = await openDb(file);
    try {
      const rows = await listAudit(db);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.actor, "alice");
      assert.equal(rows[0]?.team_id, "acme");
      assert.equal(rows[0]?.action, "reply");
      assert.equal(rows[0]?.request_id, 37074096);
      assert.equal(rows[0]?.result, "ok");
    } finally {
      await db.close();
    }
  } finally {
    cleanup();
  }
});

test("실패 기록: 종료 케이스 답변처럼 실행 전 거부돼도 result=failed:<code> 로 남는다", async () => {
  const { file, cleanup } = tempDbFile();
  try {
    await recordWriteAudit(
      { actor: "bob", teamId: DEFAULT_TEAM_ID, action: "reply", requestId: 1, result: "failed:closed" },
      file,
    );
    const db = await openDb(file);
    try {
      const rows = await listAudit(db);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.result, "failed:closed");
    } finally {
      await db.close();
    }
  } finally {
    cleanup();
  }
});

test("실패 기록: 세션 없음(session) 도 result=failed:session 으로 남는다", async () => {
  const { file, cleanup } = tempDbFile();
  try {
    await recordWriteAudit(
      { actor: "", teamId: DEFAULT_TEAM_ID, action: "create_sr", requestId: null, result: "failed:session" },
      file,
    );
    const db = await openDb(file);
    try {
      const rows = await listAudit(db);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.request_id, null);
      assert.equal(rows[0]?.result, "failed:session");
    } finally {
      await db.close();
    }
  } finally {
    cleanup();
  }
});

test("actor/team 미제공 흐름(resolveActorTeam 기본값)이 그대로 감사 로그에 남는다", async () => {
  const { file, cleanup } = tempDbFile();
  try {
    const actorTeam = resolveActorTeam({}); // 기존 화면 호출을 흉내
    assert.equal(actorTeam.ok, true);
    if (!actorTeam.ok) return;
    await recordWriteAudit(
      { actor: actorTeam.actor, teamId: actorTeam.teamId, action: "reply", requestId: 5, result: "ok" },
      file,
    );
    const db = await openDb(file);
    try {
      const rows = await listAudit(db);
      assert.equal(rows[0]?.actor, "");
      assert.equal(rows[0]?.team_id, DEFAULT_TEAM_ID);
    } finally {
      await db.close();
    }
  } finally {
    cleanup();
  }
});

test("여러 번 기록하면 감사 로그가 누적된다", async () => {
  const { file, cleanup } = tempDbFile();
  try {
    await recordWriteAudit({ actor: "a", teamId: DEFAULT_TEAM_ID, action: "reply", requestId: 1, result: "ok" }, file);
    await recordWriteAudit({ actor: "a", teamId: DEFAULT_TEAM_ID, action: "reply", requestId: 2, result: "failed:version" }, file);
    const db = await openDb(file);
    try {
      assert.equal((await listAudit(db)).length, 2);
    } finally {
      await db.close();
    }
  } finally {
    cleanup();
  }
});

test("DB 를 열 수 없어도 예외를 던지지 않는다 (감사 로그 실패가 본 작업을 막지 않는다)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "srhub-audit-badpath-"));
  try {
    // 디렉터리여야 할 자리에 파일을 만들어서, DB 파일 경로의 부모를
    // mkdirSync 가 디렉터리로 만들지 못하게 한다 (ENOTDIR).
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "x");
    const badDbFile = join(blocker, "nested", "test.db");

    await assert.doesNotReject(async () => {
      await recordWriteAudit(
        { actor: "x", teamId: DEFAULT_TEAM_ID, action: "reply", requestId: 1, result: "ok" },
        badDbFile,
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── hasTeamSession (Fix B: 쓰기 시도 전 세션 사전점검) ─────────────────

test("세션 파일이 없는 팀은 false", () => {
  const teamId = `audit-precheck-none-${Date.now()}`;
  assert.equal(hasTeamSession(teamId), false);
});

test("세션 파일이 있는 팀은 true", () => {
  const teamId = `audit-precheck-yes-${Date.now()}`;
  const path = resolve(sessionFileForTeam(teamId));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{}");
  try {
    assert.equal(hasTeamSession(teamId), true);
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("기본 팀은 기존 SESSION_FILE 경로로 세션 유무를 확인한다 (하위호환)", () => {
  // sessionFileForTeam(DEFAULT_TEAM_ID) 은 기존 SESSION_FILE 과 동일한 경로다.
  // 실제 로그인 여부에 따라 값이 달라질 수 있으므로, 같은 경로 계산으로
  // 일관된 값을 주는지만 확인한다(경로 계산 자체가 바뀌지 않았음을 보장).
  const expected = existsSync(resolve(sessionFileForTeam(DEFAULT_TEAM_ID)));
  assert.equal(hasTeamSession(DEFAULT_TEAM_ID), expected);
});

test("세션 없음(failed:session) 이 reply/create 양쪽에서 같은 모양으로 기록된다 (대칭)", async () => {
  const { file, cleanup } = tempDbFile();
  try {
    await recordWriteAudit({ actor: "d", teamId: "acme", action: "reply", requestId: 9, result: "failed:session" }, file);
    await recordWriteAudit({ actor: "d", teamId: "acme", action: "create_sr", requestId: null, result: "failed:session" }, file);
    const db = await openDb(file);
    try {
      const rows = (await listAudit(db)).sort((a, b) => a.log_id - b.log_id);
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.action, "reply");
      assert.equal(rows[0]?.result, "failed:session");
      assert.equal(rows[1]?.action, "create_sr");
      assert.equal(rows[1]?.result, "failed:session");
      assert.equal(rows[1]?.request_id, null);
    } finally {
      await db.close();
    }
  } finally {
    cleanup();
  }
});

// ── runSideEffect (Fix A: 쓰기 성공 이후 부수효과 실패를 삼킨다) ────────

test("성공하는 부수효과는 조용히 실행되고 예외 없이 끝난다", async () => {
  let called = false;
  await assert.doesNotReject(async () => {
    await runSideEffect("test-ok", () => {
      called = true;
    });
  });
  assert.equal(called, true);
});

test("동기 예외를 던지는 부수효과도 삼킨다 (persist 실패 시나리오)", async () => {
  await assert.doesNotReject(async () => {
    await runSideEffect("test-sync-throw", () => {
      throw new Error("세션 쿠키 저장 실패(디스크 문제 등)");
    });
  });
});

test("비동기(Promise) 예외를 던지는 부수효과도 삼킨다 (refresh 실패 시나리오)", async () => {
  await assert.doesNotReject(async () => {
    await runSideEffect("test-async-throw", async () => {
      throw new Error("즉시 새로고침 실패");
    });
  });
});

test(
  "reply 흐름 시뮬레이션: postReply 성공 뒤 persist 가 실패해도 " +
    "감사 로그는 result=ok, request_id 는 정상으로 남는다 (성공을 실패로 뒤집지 않는다)",
  async () => {
    const { file, cleanup } = tempDbFile();
    try {
      // postReply(...) 가 { ok: true } 를 반환했다고 가정한다.
      const postReplyResult = { ok: true as const };

      // 그 뒤 client.persist() 가 예외를 던진다 — 그래도 응답/감사는 흔들리면 안 된다.
      let persistAttempted = false;
      await runSideEffect("reply persist", () => {
        persistAttempted = true;
        throw new Error("세션 쿠키 저장 실패");
      });
      assert.equal(persistAttempted, true);

      await recordWriteAudit(
        {
          actor: "carol", teamId: "acme", action: "reply", requestId: 42,
          result: postReplyResult.ok ? "ok" : "failed:x",
        },
        file,
      );

      const db = await openDb(file);
      try {
        const rows = await listAudit(db);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.result, "ok");
        assert.equal(rows[0]?.request_id, 42);
      } finally {
        await db.close();
      }
    } finally {
      cleanup();
    }
  },
);

test(
  "create 흐름 시뮬레이션: createCase 성공 뒤 refresh 가 실패해도 " +
    "감사 로그는 result=ok, request_id 는 새로 생성된 값으로 정상 기록된다",
  async () => {
    const { file, cleanup } = tempDbFile();
    try {
      // createCase(...) 가 { ok: true, requestId: 555, ... } 를 반환했다고 가정한다.
      const createResult = { ok: true as const, requestId: 555 };

      await runSideEffect("create persist", () => {
        /* persist 는 성공했다고 가정 */
      });

      // refreshOpenCases(...) 가 예외를 던진다 — 그래도 응답/감사는 흔들리면 안 된다.
      let refreshAttempted = false;
      await runSideEffect("create refresh", async () => {
        refreshAttempted = true;
        throw new Error("목록 새로고침 실패");
      });
      assert.equal(refreshAttempted, true);

      await recordWriteAudit(
        {
          actor: "dave", teamId: DEFAULT_TEAM_ID, action: "create_sr",
          requestId: createResult.ok ? createResult.requestId : null,
          result: createResult.ok ? "ok" : "failed:x",
        },
        file,
      );

      const db = await openDb(file);
      try {
        const rows = await listAudit(db);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.result, "ok");
        assert.equal(rows[0]?.request_id, 555); // null 로 떨어지지 않는다
      } finally {
        await db.close();
      }
    } finally {
      cleanup();
    }
  },
);
