/**
 * 상시 worker — 주기 수집 루프.
 *
 * TAS 엔 Scheduler 타일이 없어 크론을 못 건다. 그래서 이 앱이 상시 떠서 일정 간격으로
 * `node collector/collect.ts`(1회성 진입점)를 **자식 프로세스로** 돌린다.
 *
 * 왜 자식 프로세스인가(프로세스 격리):
 *   collect.ts 는 브라우저/락/DB/세션을 만지며, 한 회차가 죽거나 매달리면 그 프로세스만
 *   끝나게 두고 worker 는 살아남아 다음 회차를 이어가야 한다. 같은 프로세스에서 import 로
 *   돌리면 한 번의 unhandled 예외·행이 worker 전체를 끌어내린다. 세션 hydrate·단일
 *   인스턴스 락은 collect.ts 가 이미 스스로 하므로 worker 는 중복 처리하지 않는다.
 */
import { loadEnv } from "../lib/env.ts";
loadEnv();

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isWithinHours, parseHours, resolveDurationMs } from "./schedule.ts";
import { isCloudFoundry } from "./launchPlan.ts";
import { openDb } from "../lib/db.ts";
import { COLLECT_KINDS, type CollectKind } from "../lib/collectKind.ts";
import {
  markCollectFinished, markCollectHandled, pendingCollectRequest,
} from "../lib/collectRequest.ts";
import { hasPendingJobs } from "../lib/attachmentJobs.ts";

const DEFAULT_INTERVAL_MS = 900_000; // 15분
const MIN_INTERVAL_MS = 1_000; // CPU 를 태우지 않기 위한 안전 하한
// 상한: 24시간. setTimeout 이 2^31-1ms 초과분을 1ms 로 클램프해 tight loop 가 되는 것을 막는다.
const MAX_INTERVAL_MS = 86_400_000;
const OFF_HOURS_CHECK_MS = 60_000; // 운영 시간대 밖일 때 재확인 주기
// 화면의 "지금 수집" 을 얼마나 빨리 알아채는가. 사람이 버튼을 누르고 기다리는 구간이라
// 짧게 잡는다. 이 간격마다 DB 를 한 번 읽는다(값 두 칸이라 가볍다).
const REQUEST_POLL_MS = 15_000;

const DEFAULT_TIMEOUT_MS = 300_000; // 5분 — collect 의 REQUEST_DELAY 등을 감안해도 넉넉하다
const MIN_TIMEOUT_MS = 30_000; // 너무 짧으면 정상 회차를 죽인다
const MAX_TIMEOUT_MS = 86_400_000; // 24시간 상한(setTimeout 클램프 방지)
const SIGKILL_GRACE_MS = 5_000; // SIGTERM 후 이만큼 안 죽으면 SIGKILL

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const COLLECT_ENTRY = resolve(HERE, "collect.ts");
const PREWARM_ENTRY = resolve(HERE, "prewarm.ts");
const ATTACHMENTS_ENTRY = resolve(HERE, "attachments.ts");
const CVES_ENTRY = resolve(HERE, "collect-cves.ts");
const KB_ENTRY = resolve(HERE, "collect-kb.ts");
const JUDGE_KB_ENTRY = resolve(HERE, "judge-kb.ts");
// 첨부 한 회차 상한. 브라우저 진입 10초 + 건당 수 초라 넉넉히 둔다.
const ATTACHMENTS_TIMEOUT_MS = 600_000;

// 요약은 건당 약 60초다. 한 회차 상한(SR_PREWARM_MAX, 기본 3건)에 여유를 더해 잡는다.
// collect 의 상한을 나눠 쓰지 않는다 — 수집이 요약 때문에 죽으면 안 된다.
const PREWARM_TIMEOUT_MS = 600_000;

// 보안 공지: NVD 키 없이 쓰는 한도를 지키려 키워드마다 7초를 쉰다(lib/nvd.ts). 키워드
// 여섯 개면 쉬는 시간만 42초라, 조회가 느린 날을 감안해 5분을 준다.
const CVES_TIMEOUT_MS = 300_000;
// 기술 문서: 본문을 건당 0.9초 간격으로 받는다(기본 60건). 사이트맵이 크고 남의 서버라
// 넉넉히 10분. 한 회차에 받는 수가 막혀 있어 중간에 끊겨도 다음 회차가 이어서 훑는다.
const KB_TIMEOUT_MS = 600_000;
// 환경 적합성 판정: LLM 을 건당 최대 90초 기다린다(judge-kb.ts). 기본 20건이면 원칙적으로
// 30분이지만 그만큼 붙잡으면 수집 간격을 먹는다. 15분에서 끊는다 — 판정이 안 된 문서만
// 다음 회차에 다시 잡히므로 끊어도 잃는 것이 없다.
const JUDGE_KB_TIMEOUT_MS = 900_000;

interface ChildPlan {
  /** 돌릴 자식 프로세스의 진입점. */
  readonly entry: string;
  /** 그 회차 실행 상한(ms). */
  readonly timeoutMs: number;
  /** 로그에 찍는 이름. */
  readonly label: string;
}

/**
 * 종류에 맞는 자식 프로세스를 고른다.
 *
 * 여기가 틀리면 "보안 공지를 눌렀는데 케이스 수집이 도는" 일이 생긴다. 사람은 완료를
 * 보고 목록이 그대로인 이유를 알 수 없으므로, 짝이 흐트러지지 않게 한곳에 모아 둔다.
 *
 * 케이스만 상한이 환경변수(SR_COLLECT_TIMEOUT_MS)를 따른다 — 브라우저를 쓰는 회차라
 * 현장에서 늘려야 할 때가 있다. 나머지 둘은 HTTP 로만 받아 예측 가능한 값이면 된다.
 */
export function childPlanFor(kind: CollectKind, casesTimeoutMs: number): ChildPlan {
  switch (kind) {
    case "cases":
      return { entry: COLLECT_ENTRY, timeoutMs: casesTimeoutMs, label: "수집" };
    case "cves":
      return { entry: CVES_ENTRY, timeoutMs: CVES_TIMEOUT_MS, label: "보안 공지 수집" };
    case "kb":
      return { entry: KB_ENTRY, timeoutMs: KB_TIMEOUT_MS, label: "기술 문서 수집" };
  }
}

interface WorkerConfig {
  /** 회차 사이 간격(ms). */
  readonly intervalMs: number;
  /** 한 회차(자식 프로세스) 실행 상한(ms). 넘기면 죽이고 다음 회차로 넘어간다. */
  readonly timeoutMs: number;
  /** 운영 시간대 스펙("8-20"). 빈문자열이면 24시간 실행. */
  readonly hoursSpec: string;
}

// 루프 제어 상태. 시그널 핸들러와 루프가 공유한다.
let stopping = false;
// 잠자는 중이면 이 함수로 즉시 깨운다(시그널 수신 시 대기 단축).
let wakeSleeper: (() => void) | null = null;

/** 환경변수에서 설정을 읽는다. 값이 부적절하면 안전한 기본값으로 떨어지고 경고를 남긴다. */
function readConfig(): WorkerConfig {
  const interval = resolveDurationMs(
    process.env.SR_COLLECT_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
    MIN_INTERVAL_MS,
    MAX_INTERVAL_MS,
  );
  if (interval.warning !== null) console.error(`[worker] SR_COLLECT_INTERVAL_MS ${interval.warning}`);

  const timeout = resolveDurationMs(
    process.env.SR_COLLECT_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  if (timeout.warning !== null) console.error(`[worker] SR_COLLECT_TIMEOUT_MS ${timeout.warning}`);

  const hoursSpec = (process.env.SR_COLLECT_HOURS ?? "").trim();
  if (hoursSpec !== "" && parseHours(hoursSpec) === null) {
    console.error(`[worker] SR_COLLECT_HOURS 형식이 잘못되어 무시합니다(24시간 실행): ${hoursSpec}`);
    return { intervalMs: interval.value, timeoutMs: timeout.value, hoursSpec: "" };
  }

  return { intervalMs: interval.value, timeoutMs: timeout.value, hoursSpec };
}

/** 시그널 없으면 ms 뒤에, 시그널 오면 즉시 깬다. */
function interruptibleSleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    const timer = setTimeout(() => {
      wakeSleeper = null;
      resolveSleep();
    }, ms);
    wakeSleeper = () => {
      clearTimeout(timer);
      wakeSleeper = null;
      resolveSleep();
    };
  });
}

interface CollectJob {
  readonly kind: CollectKind;
  readonly seq: number;
}

/**
 * 화면에서 "지금 수집" 을 눌렀는지 종류별로 본다. 눌린 것들을 돌려준다.
 *
 * 집어가는 표시를 여기서 함께 한다 — 회차를 돌리기 전에 찍어야 5분 도는 동안 같은
 * 요청을 다시 보고 또 돌리는 일이 없다.
 *
 * 종류 셋을 연결 하나로 본다. 15초마다 부르는 길이라 연결을 세 번 열고 닫을 이유가 없다.
 *
 * DB 를 못 읽어도 루프를 세우지 않는다. 정기 수집은 이것과 무관하게 돌아야 한다.
 */
async function takeCollectRequests(): Promise<CollectJob[]> {
  try {
    const db = await openDb();
    try {
      const jobs: CollectJob[] = [];
      for (const kind of COLLECT_KINDS) {
        const seq = await pendingCollectRequest(db, kind);
        if (seq === null) continue;
        await markCollectHandled(db, kind, seq);
        jobs.push({ kind, seq });
      }
      return jobs;
    } finally {
      await db.close();
    }
  } catch (error) {
    console.error("[worker] 수집 요청 확인 실패(정기 수집은 계속):", error instanceof Error ? error.message : String(error));
    return [];
  }
}

/**
 * 그 요청이 끝났다고 남긴다. 화면이 이것을 보고 "완료" 로 바꾼다.
 *
 * 케이스 수집은 runs 에 회차를 남기므로 화면이 그걸 봐도 되지만, 보안 공지·기술 문서
 * 수집기는 runs 에 아무것도 남기지 않는다. 표시를 안 하면 버튼이 영원히 "수집 중" 이다.
 *
 * 못 남겨도 루프를 세우지 않는다. 버튼이 상한까지 기다렸다 놓아주는 것이, 수집기가
 * 멈추는 것보다 낫다.
 */
async function noteCollectFinished(job: CollectJob, ok: boolean): Promise<void> {
  try {
    const db = await openDb();
    try {
      await markCollectFinished(db, job.kind, job.seq, ok);
    } finally {
      await db.close();
    }
  } catch (error) {
    console.error("[worker] 수집 완료 표시 실패(회차는 정상):", error instanceof Error ? error.message : String(error));
  }
}

/**
 * 요청 하나를 돌리고 끝났음을 표시한다. 케이스는 부르는 쪽에서 따로 돌린다.
 *
 * 기술 문서는 수집 뒤 판정(judge-kb.ts)까지 이어서 돌린다. 근거 —
 * collect-kb.ts 는 끝날 때 "판정은 npm run judge:kb 로 이어서 합니다" 라고 안내하는데,
 * 화면만 쓰는 사람은 터미널이 없어 그 명령을 칠 수 없다. 그러면 새로 받은 문서가
 * 영원히 '미판정' 으로 남는다. judge-kb 는 판정이 없는 것만 보고(반복 실행이 안전),
 * LLM 연결이 없으면 스스로 안내만 남기고 끝나므로 이어 붙여도 해롭지 않다. 수집 뒤에
 * LLM 일을 자식 프로세스로 한 번 더 돌리는 것은 요약 예열(prewarm)과 같은 결이다.
 *
 * 완료 표시는 판정 **앞에서** 찍는다. 사람이 버튼 앞에서 기다리는 것은 수집까지이고,
 * 판정은 건당 최대 90초라 붙잡아 두면 버튼이 기다리다 상한을 넘긴다.
 */
async function runRequestedJob(job: CollectJob, casesTimeoutMs: number): Promise<void> {
  const plan = childPlanFor(job.kind, casesTimeoutMs);
  console.log(`[worker] 화면에서 ${plan.label}을 요청했습니다(${job.seq}) — 지금 한 회차를 돌립니다.`);
  const ok = await runChildOnce(plan.entry, plan.timeoutMs, plan.label);
  await noteCollectFinished(job, ok);

  if (job.kind === "kb" && ok && !stopping) {
    await runChildOnce(JUDGE_KB_ENTRY, JUDGE_KB_TIMEOUT_MS, "환경 적합성 판정");
  }
}

/**
 * 대기 중인 첨부 일이 있는가.
 *
 * 첨부는 브라우저가 있어야 처리되므로 이 기계가 해야 한다. 사람이 앞에서 기다리는
 * 구간이라 수집 간격(15분)을 기다리게 두지 않는다. DB 를 못 읽어도 루프는 세우지 않는다.
 */
async function attachmentsWaiting(): Promise<boolean> {
  try {
    const db = await openDb();
    try {
      return await hasPendingJobs(db);
    } finally {
      await db.close();
    }
  } catch (error) {
    console.error("[worker] 첨부 일 확인 실패(수집은 계속):", error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * ms 동안 자되, 중간에 "지금 수집" 요청이 오면 바로 깬다.
 *
 * interruptibleSleep 을 짧게 여러 번 나눠 걸고 사이마다 DB 를 본다. 시그널로 깨우는
 * 길(wakeSleeper)은 그대로 살아 있어야 하므로 그 함수를 그대로 쓴다.
 *
 * 보안 공지·기술 문서 요청은 **여기서 바로** 돌린다. 케이스 요청만 그 번호를 돌려주고
 * 루프 머리로 넘긴다 — 케이스 회차는 요약 예열·첨부까지 한 벌로 돌아야 해서, 여기서
 * 수집만 돌리면 그 뒤가 빠진다. 케이스 요청이 없었으면 null 이고, 그때는 수집 간격을
 * 다시 재지 않는다(CVE 를 눌렀다고 케이스 주기가 밀릴 이유는 없다).
 */
async function sleepWatchingRequests(ms: number, casesTimeoutMs: number): Promise<number | null> {
  let left = ms;
  while (left > 0 && !stopping) {
    const chunk = Math.min(REQUEST_POLL_MS, left);
    await interruptibleSleep(chunk);
    left -= chunk;
    if (stopping) return null;

    let casesSeq: number | null = null;
    for (const job of await takeCollectRequests()) {
      if (job.kind === "cases") {
        casesSeq = job.seq;
        continue;
      }
      await runRequestedJob(job, casesTimeoutMs);
      if (stopping) return casesSeq;
    }
    if (casesSeq !== null) {
      console.log(`[worker] 화면에서 수집을 요청했습니다(${casesSeq}) — 지금 한 회차를 돌립니다.`);
      return casesSeq;
    }

    // 첨부는 사람이 앞에서 기다린다. 수집 간격을 기다리게 두지 않는다.
    if (await attachmentsWaiting()) {
      await runChildOnce(ATTACHMENTS_ENTRY, ATTACHMENTS_TIMEOUT_MS, "첨부");
    }
  }
  return null;
}

/**
 * 수집 한 회차를 자식 프로세스로 돌리고, 상한 타임아웃(watchdog)을 걸어 기다린다.
 *
 * stdio 는 상위로 상속(inherit)해 collect.ts 의 로그가 그대로 보이게 한다.
 * cwd 는 레포 루트(collect.ts 가 상대경로로 .env·data 를 찾으므로).
 * 자식이 끝나야 resolve 하므로 좀비/유령 프로세스를 남기지 않는다.
 *
 * watchdog: collect.ts 는 과거 4시간+ hang 이력이 있고, manifest 의 health-check-type:process
 * 는 PID 생존만 봐서 '죽지 않았지만 멈춘' 상태를 못 잡는다. 그래서 timeoutMs 를 넘기면
 * SIGTERM → (SIGKILL_GRACE_MS 뒤에도 살아 있으면) SIGKILL 로 죽이고 그 회차를 timeout 으로
 * 남긴 뒤 다음 회차로 넘어간다. 죽인 자식이 쥔 collect 락은 다음 회차에서 pid 생존 체크로
 * 회수되므로 worker 는 계속 진행하면 된다. 정상 종료 시 타이머는 반드시 정리한다(누수 금지).
 *
 * 성공 여부(종료코드 0 이고 죽이지 않았음)를 돌려준다. 화면이 "완료" 라고 말하기 전에
 * 그 회차가 실제로 끝난 것인지 알아야 하는데, 케이스 말고는 runs 에 흔적이 없다.
 */
function runChildOnce(entry: string, timeoutMs: number, label: string): Promise<boolean> {
  return new Promise((resolveRun) => {
    const startedMs = Date.now();
    const child = spawn(process.execPath, [entry], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });

    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const watchdog = setTimeout(() => {
      timedOut = true;
      console.error(`[worker] ${label} 회차가 상한(${timeoutMs}ms)을 넘겨 중단합니다(timeout → SIGTERM).`);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        console.error("[worker] 자식이 SIGTERM 에 응답하지 않아 강제 종료합니다(SIGKILL).");
        child.kill("SIGKILL");
      }, SIGKILL_GRACE_MS);
    }, timeoutMs);

    // 타이머 정리(정상/에러/타임아웃 어느 경로로 끝나든 한 번만). 누수·중복 kill 방지.
    const cleanup = (): void => {
      clearTimeout(watchdog);
      if (killTimer !== null) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      console.error(`[worker] ${label} 프로세스 시작 실패: ${error.message}`);
      resolveRun(false);
    });

    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      const secs = ((Date.now() - startedMs) / 1000).toFixed(1);
      let how: string;
      if (timedOut) how = `timeout, ${secs}s`;
      else if (signal !== null) how = `시그널 ${signal}, ${secs}s`;
      else how = `종료코드 ${code ?? "?"}, ${secs}s`;
      console.log(`[worker] ${label} 회차 종료 (${how})`);
      resolveRun(!timedOut && signal === null && code === 0);
    });
  });
}

/** 주기 실행 루프. stopping 이 서면 안전하게 빠져나온다. */
async function runLoop(config: WorkerConfig): Promise<void> {
  const scope = config.hoursSpec === "" ? "24시간" : `운영시간 ${config.hoursSpec}`;
  console.log(`[worker] 시작 — 간격 ${config.intervalMs}ms, 회차 상한 ${config.timeoutMs}ms, ${scope}`);

  // 이번 회차가 사람이 누른 요청인지. 그렇다면 끝난 뒤 그 번호로 완료를 찍어야 한다.
  let casesRequest: number | null = null;

  while (!stopping) {
    if (isWithinHours(new Date(), config.hoursSpec)) {
      const ok = await runChildOnce(COLLECT_ENTRY, config.timeoutMs, "수집");
      // 요약 예열보다 **먼저** 찍는다. 사람이 버튼 앞에서 기다리는 것은 수집까지다.
      if (casesRequest !== null) {
        await noteCollectFinished({ kind: "cases", seq: casesRequest }, ok);
        casesRequest = null;
      }
      if (stopping) break;

      // 새로 종료된 케이스의 요약을 미리 만든다. 수집과 프로세스를 나눈 이유는
      // prewarm.ts 머리말 참고 — 요약이 수집의 watchdog 을 먹어 치우면 안 된다.
      // 실패해도 다음 회차에 다시 시도되므로 여기서 붙잡지 않는다.
      await runChildOnce(PREWARM_ENTRY, PREWARM_TIMEOUT_MS, "요약 예열");
      if (stopping) break;

      // 수집 중에 쌓인 첨부 일을 처리한다.
      if (await attachmentsWaiting()) {
        await runChildOnce(ATTACHMENTS_ENTRY, ATTACHMENTS_TIMEOUT_MS, "첨부");
        if (stopping) break;
      }

      // 자는 동안에도 화면의 "지금 수집" 을 본다. 오면 간격을 기다리지 않고 깬다.
      casesRequest = await sleepWatchingRequests(config.intervalMs, config.timeoutMs);
    } else {
      // 운영 시간대 밖 — 정기 회차는 건너뛴다. 그래도 사람이 직접 요청했으면 돌린다.
      // 종류를 가리지 않는다. 보안 공지·기술 문서는 Broadcom 세션을 쓰지 않으므로
      // 운영 시간대와 무관하게 돌아도 된다.
      for (const job of await takeCollectRequests()) {
        console.log(`[worker] 운영 시간대 밖이지만 요청이 있어 돌립니다(${job.kind} ${job.seq}).`);
        await runRequestedJob(job, config.timeoutMs);
        if (stopping) break;
      }
      if (stopping) break;
      // 운영 시간대 밖이라도 첨부는 처리한다. 사람이 앞에서 기다리는 일이다.
      if (await attachmentsWaiting()) {
        await runChildOnce(ATTACHMENTS_ENTRY, ATTACHMENTS_TIMEOUT_MS, "첨부");
        if (stopping) break;
      }
      await interruptibleSleep(Math.min(OFF_HOURS_CHECK_MS, config.intervalMs));
    }
  }

  console.log("[worker] 루프 종료.");
}

/**
 * 우아한 종료.
 *
 * CF 는 셧다운에 SIGTERM 을 보낸다. 진행 중 자식은 강제로 죽이지 않고 끝나길 기다리며
 * (runLoop 가 runChildOnce 를 await 중), 잠자는 중이면 즉시 깨워 루프를 멈춘다.
 * 이렇게 하면 반쯤 쓰다 만 회차나 유령 자식 프로세스를 남기지 않는다.
 */
function requestStop(signal: string): void {
  if (stopping) return;
  console.log(`[worker] ${signal} 수신 — 진행 중 회차를 마치고 종료합니다.`);
  stopping = true;
  if (wakeSleeper !== null) wakeSleeper();
}

/**
 * 컨테이너에서 무인 재로그인이 확실히 헤드리스(@sparticuz/chromium) 경로를 타도록 보장한다.
 *
 * collect.ts 는 세션이 만료되면 스스로 브라우저로 재로그인한다(acquireBrowserSession →
 * launchBrowser). 컨테이너엔 브라우저 바이너리가 없어 그 경로는 번들 Chromium 으로만 뜬다.
 * session.ts 가 CF(VCAP_APPLICATION)를 자동 감지하지만, 무인 재로그인이 걸린 지점이라
 * 의도를 명시해 둔다 — CF 이면서 설정이 없을 때만 SR_HEADLESS 를 켜 자식(collect.ts)이
 * 이를 상속하게 한다. 로컬에서 `npm run worker` 로 돌릴 땐 건드리지 않는다(headed 유지).
 */
export function ensureContainerHeadless(): void {
  if (isCloudFoundry(process.env) && (process.env.SR_HEADLESS ?? "").trim() === "") {
    process.env.SR_HEADLESS = "1";
    console.log("[worker] CF 컨테이너 감지 — 무인 재로그인을 위해 SR_HEADLESS=1 설정.");
  }
}

function main(): void {
  ensureContainerHeadless();
  const config = readConfig();
  process.on("SIGTERM", () => requestStop("SIGTERM"));
  process.on("SIGINT", () => requestStop("SIGINT"));

  runLoop(config).catch((error: unknown) => {
    console.error(`[worker] 루프 오류: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

// 진입점으로 직접 실행될 때만 루프를 돈다. 테스트가 스케줄 함수를 import 할 때
// argv/시그널/spawn 부작용이 없어야 하므로 여기서 가드한다(scripts/seed-session.ts 참고).
const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  main();
}
