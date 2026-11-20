/**
 * 올리기의 실패 처리 — 재시도·상한·"올렸지만 확인 못 함".
 *
 * 순수한 계산은 test/crushftp.test.ts 가 잠근다. 여기서 재는 것은 **전송이 깨졌을 때
 * 어떻게 행동하는가** 다. 2026-11-17 에 첨부 한 건이 화면에
 * `KakaoTalk_….jpg: fetch failed` 로 끝났고, 그때 코드는
 *
 *   - 사유를 버렸고(cause 를 안 봤다),
 *   - 상한이 없었고,
 *   - **다시 보내도 되는 자리에서** 다시 보내지 않았고,
 *   - 확인만 실패한 경우를 실패로 적어 우리 사본까지 지웠다.
 *
 * 네 가지가 각각 한 테스트다. fetch 를 바꿔 끼워 재므로 망이 필요 없다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CookieJar } from "../collector/cookieJar.ts";

// ★ 모듈이 import 시점에 읽는다. 재시도 간격을 0 으로 만들어야 8초를 기다리지 않는다.
process.env.SR_UPLOAD_RETRY_MS = "0";
const { UploadError, uploadTimeoutMs, uploadToCase } = await import("../lib/crushftp.ts");

const SITE = "10000001";   // 자리표시자
const CASE = 20000002;     // 자리표시자
const NAME = "photo.jpg";
const BYTES = new Uint8Array([1, 2, 3, 4]);

function jar(): CookieJar {
  return new CookieJar([{
    name: "CrushAuth",
    value: "1759000000000_AbCdEfGhIjKlBb30",
    domain: "supportftp.broadcom.com",
    path: "/",
  }]);
}

/** undici 가 연결이 깨졌을 때 던지는 모양. */
function transportError(detail = "connect ETIMEDOUT 10.0.0.1:443", code = "ETIMEDOUT"): TypeError {
  const inner = new Error(detail) as Error & { code?: string };
  inner.code = code;
  return new TypeError("fetch failed", { cause: inner });
}

const LISTING = `{"files":[{"name":"${NAME}","size":4}]}`;

interface Call { readonly method: string }

/**
 * fetch 를 바꿔 끼운다.
 *
 * `plan` 은 PUT 요청에 대한 답을 차례로 꺼내 쓴다(Error 면 던진다). 목록 조회(POST)는
 * `listing` 으로 답한다. 실제로 몇 번 불렸는지 돌려준다 — **재시도를 세는 것이 요점**이다.
 */
function withFetch(
  plan: ReadonlyArray<Response | Error>,
  listing: Response | Error = new Response(LISTING, { status: 200 }),
): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  let next = 0;

  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method });
    if (method === "PUT") {
      const answer = plan[Math.min(next, plan.length - 1)];
      next += 1;
      if (answer instanceof Error) throw answer;
      return answer ?? new Response("", { status: 200 });
    }
    if (listing instanceof Error) throw listing;
    return listing;
  }) as typeof globalThis.fetch;

  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function upload(
  plan: ReadonlyArray<Response | Error>,
  listing?: Response | Error,
): Promise<{ result?: unknown; error?: unknown; calls: Call[] }> {
  const fake = withFetch(plan, listing);
  try {
    const result = await uploadToCase(jar(), { site: SITE, caseId: CASE, fileName: NAME, bytes: BYTES });
    return { result, calls: fake.calls };
  } catch (error) {
    return { error, calls: fake.calls };
  } finally {
    fake.restore();
  }
}

const puts = (calls: Call[]): number => calls.filter((c) => c.method === "PUT").length;

/* ------------------------------------------------------------------ *
 * 상한 — 크기에 비례한다
 * ------------------------------------------------------------------ */

test("작은 파일에도 최소 60초는 준다", () => {
  assert.equal(uploadTimeoutMs(0), 60_000);
  assert.equal(uploadTimeoutMs(50 * 1024), 61_000);
});

test("큰 파일은 더 기다린다 — 올라가는 중에 끊지 않는다", () => {
  // 실측 처리량이 초당 600KB 남짓이었다. 5.6MB 에 60초만 주면 멀쩡히 올라가다 끊긴다.
  assert.ok(uploadTimeoutMs(5.6 * 1024 * 1024) > 100_000);
});

test("상한은 수집기가 프로세스를 죽이는 600초보다 작다", () => {
  // 바깥이면 우리가 만든 사유 대신 "프로세스가 죽었다" 만 남고, 행은 running 으로
  // 남아 15분 뒤 되살아날 때까지 사람은 "처리 중" 만 본다.
  assert.ok(uploadTimeoutMs(50 * 1024 * 1024) < 600_000);
  assert.equal(uploadTimeoutMs(10 * 1024 * 1024 * 1024), 420_000, "예산과 같아야 한다");
});

/* ------------------------------------------------------------------ *
 * 전송이 깨졌을 때 — 여기서는 다시 보내도 안전하다
 *
 * 목적지가 고정 경로이고 본문이 같아서 두 번 보내면 덮어쓰기가 된다. 화면의 POST 를
 * 자동 재시도하지 않는 것과 정반대인데, 지금까지 재시도가 안전한 유일한 구간에만
 * 재시도가 없었다.
 * ------------------------------------------------------------------ */

test("전송이 깨지면 다시 보낸다", async () => {
  const { result, error, calls } = await upload([
    transportError(),
    transportError(),
    new Response("", { status: 200 }),
  ]);
  assert.equal(error, undefined, "세 번째에 성공해야 한다");
  assert.equal(puts(calls), 3);
  assert.equal((result as { attempts: number }).attempts, 3, "몇 번 걸렸는지 말해야 한다");
});

test("한 번에 되면 한 번만 보낸다", async () => {
  const { result, calls } = await upload([new Response("", { status: 200 })]);
  assert.equal(puts(calls), 1);
  assert.equal((result as { attempts: number }).attempts, 1);
});

test("끝까지 깨지면 사유와 시도 횟수를 담아 알린다", async () => {
  const { error, calls } = await upload([
    transportError("getaddrinfo ENOTFOUND supportftp.broadcom.com", "ENOTFOUND"),
  ]);
  assert.equal(puts(calls), 3, "상한까지 해봐야 한다");
  assert.ok(error instanceof UploadError);
  assert.equal(error.code, "transport");
  // 이것이 이번 수정의 핵심이다 — "fetch failed" 넉 자로 끝나지 않는다.
  assert.match(error.message, /DNS/);
  assert.match(error.message, /ENOTFOUND/);
  assert.match(error.message, /3번 시도/);
  assert.doesNotMatch(error.message, /^fetch failed/);
});

/* ------------------------------------------------------------------ *
 * 서버가 판단해서 거절한 것은 다시 보내지 않는다 — 보내도 같은 답이다
 * ------------------------------------------------------------------ */

test("세션 거절(403)은 재시도하지 않는다", async () => {
  const { error, calls } = await upload([new Response("denied", { status: 403 })]);
  assert.equal(puts(calls), 1);
  assert.ok(error instanceof UploadError);
  assert.equal(error.code, "session");
  assert.match(error.message, /다시 로그인/);
});

test("서버 거절(400)은 재시도하지 않는다", async () => {
  const { error, calls } = await upload([new Response("bad request", { status: 400 })]);
  assert.equal(puts(calls), 1);
  assert.ok(error instanceof UploadError);
  assert.equal(error.code, "rejected");
});

/* ------------------------------------------------------------------ *
 * 올렸는데 확인만 못 한 경우
 *
 * 전에는 이것도 실패였다. 그러면 ① 파일은 올라가 있는데 화면은 실패라고 말하고,
 * ② 사람이 다시 올려 케이스에 같은 파일이 두 번 붙고, ③ finishJob 이 실패 경로에서
 * payload 를 비워 **우리가 보낸 파일의 유일한 사본**까지 사라진다.
 * ------------------------------------------------------------------ */

test("확인만 실패하면 unverified — 올라갔다고 말한다", async () => {
  const { error } = await upload(
    [new Response("", { status: 200 })],
    transportError("read ECONNRESET", "ECONNRESET"),
  );
  assert.ok(error instanceof UploadError);
  assert.equal(error.code, "unverified", "실패로 적으면 사본이 지워진다");
  assert.match(error.message, /올렸지만/);
  assert.match(error.message, /포털에서/);
});

test("목록에 파일이 없으면 그건 진짜 실패다", async () => {
  const { error } = await upload(
    [new Response("", { status: 200 })],
    new Response(`{"files":[{"name":"other.txt"}]}`, { status: 200 }),
  );
  assert.ok(error instanceof UploadError);
  assert.equal(error.code, "mismatch");
});
