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

const DEFAULT_INTERVAL_MS = 900_000; // 15분
const MIN_INTERVAL_MS = 1_000; // CPU 를 태우지 않기 위한 안전 하한
// 상한: 24시간. setTimeout 이 2^31-1ms 초과분을 1ms 로 클램프해 tight loop 가 되는 것을 막는다.
const MAX_INTERVAL_MS = 86_400_000;
const OFF_HOURS_CHECK_MS = 60_000; // 운영 시간대 밖일 때 재확인 주기

const DEFAULT_TIMEOUT_MS = 300_000; // 5분 — collect 의 REQUEST_DELAY 등을 감안해도 넉넉하다
const MIN_TIMEOUT_MS = 30_000; // 너무 짧으면 정상 회차를 죽인다
const MAX_TIMEOUT_MS = 86_400_000; // 24시간 상한(setTimeout 클램프 방지)
const SIGKILL_GRACE_MS = 5_000; // SIGTERM 후 이만큼 안 죽으면 SIGKILL

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const COLLECT_ENTRY = resolve(HERE, "collect.ts");

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
 */
function runCollectOnce(timeoutMs: number): Promise<void> {
  return new Promise((resolveRun) => {
    const startedMs = Date.now();
    const child = spawn(process.execPath, [COLLECT_ENTRY], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });

    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const watchdog = setTimeout(() => {
      timedOut = true;
      console.error(`[worker] 수집 회차가 상한(${timeoutMs}ms)을 넘겨 중단합니다(timeout → SIGTERM).`);
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
      console.error(`[worker] 수집 프로세스 시작 실패: ${error.message}`);
      resolveRun();
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
      console.log(`[worker] 수집 회차 종료 (${how})`);
      resolveRun();
    });
  });
}

/** 주기 실행 루프. stopping 이 서면 안전하게 빠져나온다. */
async function runLoop(config: WorkerConfig): Promise<void> {
  const scope = config.hoursSpec === "" ? "24시간" : `운영시간 ${config.hoursSpec}`;
  console.log(`[worker] 시작 — 간격 ${config.intervalMs}ms, 회차 상한 ${config.timeoutMs}ms, ${scope}`);

  while (!stopping) {
    if (isWithinHours(new Date(), config.hoursSpec)) {
      await runCollectOnce(config.timeoutMs);
      if (stopping) break;
      await interruptibleSleep(config.intervalMs);
    } else {
      // 운영 시간대 밖 — 이번 회차는 건너뛰고 짧게 자다 재확인한다.
      await interruptibleSleep(Math.min(OFF_HOURS_CHECK_MS, config.intervalMs));
    }
  }

  console.log("[worker] 루프 종료.");
}

/**
 * 우아한 종료.
 *
 * CF 는 셧다운에 SIGTERM 을 보낸다. 진행 중 자식은 강제로 죽이지 않고 끝나길 기다리며
 * (runLoop 가 runCollectOnce 를 await 중), 잠자는 중이면 즉시 깨워 루프를 멈춘다.
 * 이렇게 하면 반쯤 쓰다 만 회차나 유령 자식 프로세스를 남기지 않는다.
 */
function requestStop(signal: string): void {
  if (stopping) return;
  console.log(`[worker] ${signal} 수신 — 진행 중 회차를 마치고 종료합니다.`);
  stopping = true;
  if (wakeSleeper !== null) wakeSleeper();
}

function main(): void {
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
