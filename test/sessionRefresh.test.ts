/**
 * 401 을 받았을 때 세션을 강제로 다시 받아오는 것.
 *
 * **세션은 만료 시각이 오기 전에도 죽는다.** 수집기가 재로그인하면 앞선 세션이 서버
 * 쪽에서 무효가 되는데, 그 쿠키의 만료 시각은 여전히 미래다. 그래서 hydrate 는
 * "살아 있다" 고 보고 DB 를 쳐다보지 않고, 웹은 죽은 세션으로 계속 요청을 보낸다.
 * 사람은 "세션이 만료되었습니다" 만 반복해서 본다 — 실제로 그렇게 막혔다.
 *
 * 평상시에는 이 함수를 부르면 안 된다. 조건 없이 덮어쓰므로 방금 회전된 로컬 쿠키를
 * 오래된 DB 로 되돌릴 수 있다. 그 성질을 여기서 잠근다.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { sessionFileForTeam } from "../lib/config.ts";
import { openDb } from "../lib/db.ts";
import {
  hydrateTeamSessionFromDb,
  persistTeamSessionToDb,
  refreshTeamSessionFromDb,
} from "../lib/sessionStore.ts";

const TEAM = `refresh-${Date.now()}`;
const sessionPath = resolve(sessionFileForTeam(TEAM));

const HOUR_MS = 3_600_000;
/** 실제 쿠키 값은 쓰지 않는다 — 판정에 쓰이는 것은 이름과 만료뿐이다. */
function sessionJson(hoursFromNow: number, mark: string): string {
  return JSON.stringify({
    mark,
    cookies: [
      {
        name: "sspsession",
        domain: ".access.broadcom.com",
        path: "/",
        expires: (Date.now() + hoursFromNow * HOUR_MS) / 1000,
      },
    ],
  });
}

function write(content: string): void {
  mkdirSync(dirname(sessionPath), { recursive: true });
  writeFileSync(sessionPath, content, "utf8");
}

after(() => {
  try { rmSync(resolve(`data/teams/${TEAM}`), { recursive: true, force: true }); } catch { /* noop */ }
});

async function freshDb() {
  return openDb(join(mkdtempSync(join(tmpdir(), "refresh-")), "sr.db"));
}

test("401 이면 살아 보이는 파일이라도 DB 것으로 바꾼다", async () => {
  const db = await freshDb();
  // 수집기가 재로그인해 DB 에 새 세션을 올린 상태.
  const fromCollector = sessionJson(11, "수집기가 방금 만든 것");
  write(fromCollector);
  await persistTeamSessionToDb(TEAM, db);

  // 웹이 들고 있는 것은 **만료 시각은 아직 미래지만 서버에서는 죽은** 세션이다.
  const dead = sessionJson(9, "서버에서 이미 무효");
  write(dead);

  // hydrate 는 손대지 않는다 — 파일이 살아 보이기 때문이다. 이게 문제의 원인이었다.
  await hydrateTeamSessionFromDb(TEAM, db);
  assert.equal(readFileSync(sessionPath, "utf8"), dead, "hydrate 는 이 경우를 못 고친다");

  // 401 을 받은 뒤에는 강제로 바꾼다.
  assert.equal(await refreshTeamSessionFromDb(TEAM, db), true);
  assert.equal(readFileSync(sessionPath, "utf8"), fromCollector);
  await db.close();
});

// 같은 내용이면 다시 보내 봐야 또 401 이다. 헛되이 재시도하지 않는다.
test("DB 가 같은 내용이면 false — 재시도하지 않는다", async () => {
  const db = await freshDb();
  const same = sessionJson(10, "같은 것");
  write(same);
  await persistTeamSessionToDb(TEAM, db);

  assert.equal(await refreshTeamSessionFromDb(TEAM, db), false);
  assert.equal(readFileSync(sessionPath, "utf8"), same);
  await db.close();
});

test("DB 에 백업이 없으면 false", async () => {
  const db = await freshDb();
  const mine = sessionJson(10, "내 것");
  write(mine);
  assert.equal(await refreshTeamSessionFromDb(TEAM, db), false, "없는 것으로 덮어쓰면 안 된다");
  assert.equal(readFileSync(sessionPath, "utf8"), mine);
  await db.close();
});

test("파일이 아예 없어도 DB 것으로 채운다", async () => {
  const db = await freshDb();
  const backup = sessionJson(10, "DB 것");
  write(backup);
  await persistTeamSessionToDb(TEAM, db);
  rmSync(sessionPath, { force: true });

  assert.equal(await refreshTeamSessionFromDb(TEAM, db), true);
  assert.equal(readFileSync(sessionPath, "utf8"), backup);
  await db.close();
});
