/**
 * 수집기가 돌고 있는가.
 *
 * ## 왜 필요한가
 *
 * 세션이 죽으면 화면은 "세션이 만료되었습니다. 다시 로그인하세요" 라고 말했다. 그런데
 * **웹에서는 로그인할 수 없다** — 컨테이너에 브라우저가 없어 `/login` 이 세션을 만들지
 * 못한다(SR_DISABLE_BROWSER_LOGIN). 세션을 다시 만드는 것은 수집기가 하는 일이고,
 * 수집기는 회차를 시작할 때 세션이 죽어 있으면 저장된 계정으로 **스스로 재로그인한다**
 * (collector/collect.ts). 그래서 사람이 할 일은 로그인이 아니라 "수집기에 한 회차를
 * 지금 돌려 달라고 요청하는 것" 이다(lib/collectRequest.ts).
 *
 * 그 요청이 뜻이 있으려면 **수집기가 돌고 있어야** 한다. 멈춰 있으면 요청은 줄에 남아
 * 아무 일도 일어나지 않는데, 화면이 "요청했습니다" 만 보여 주면 사람은 영원히 기다린다.
 * 둘은 사람이 할 일이 완전히 다르다 — 하나는 기다리기, 하나는 VM 을 보기.
 *
 * ## 판정은 순수 함수로
 *
 * 시계·DB·환경을 만지지 않는 `judgeCollector` 로 떼어 두고 시험으로 잠근다. 이 판정이
 * 틀리면 **아무 문제 없는 날에 "수집기가 멈췄다" 고 말하거나**, 정말 멈춘 날에 계속
 * 기다리라고 말한다. 둘 다 조용한 고장이다.
 *
 * ## 밤에는 안 도는 것이 정상이다
 *
 * worker 는 `SR_COLLECT_HOURS`(예 "8-20") 밖에서는 자고 회차를 돌리지 않는다. 그걸
 * 모르고 판정하면 매일 아침 "12시간 동안 멈췄다" 고 말한다. 그래서 운영 시간대 밖이면
 * **멈춤으로 보지 않는다**(collector/schedule.ts 의 isWithinHours — worker 가 쓰는 그
 * 함수를 그대로 쓴다. 갈라지면 둘의 판정이 어긋난다).
 *
 * 웹 앱에 `SR_COLLECT_HOURS` 가 설정돼 있지 않으면 24시간 운영으로 본다. 그 경우
 * 밤중에 "멈춤" 이 뜰 수 있어서, 문구에 그 가능성을 함께 적는다(화면 쪽).
 */
import { isWithinHours } from "../collector/schedule.ts";

/** worker 의 기본 회차 간격(collector/worker.ts DEFAULT_INTERVAL_MS 와 같은 값). */
export const DEFAULT_COLLECT_INTERVAL_MS = 900_000;

/**
 * 간격의 몇 배까지 조용한 것을 정상으로 볼 것인가.
 *
 * 한 배로 잡으면 회차가 조금 길어진 날마다 "멈췄다" 가 뜬다 — 한 회차는 몇 분씩
 * 걸리고(브라우저를 띄우고 케이스를 훑는다) 간격은 그 뒤부터 센다. 세 배(기본 45분)면
 * 정상적인 지연으로는 닿지 않고, 정말 멈춘 경우는 한 시간 안에 드러난다.
 */
const STALL_FACTOR = 3;

export type CollectorState =
  /** 최근에 돌았다. */
  | "ok"
  /** 운영 시간대 밖이다 — 안 도는 것이 정상이다. */
  | "resting"
  /** 돌아야 할 시간인데 한참 조용하다. */
  | "stalled"
  /** 한 번도 돈 기록이 없다. */
  | "never";

export interface CollectorJudgement {
  readonly state: CollectorState;
  /** 마지막 회차가 시작된 뒤 흐른 시간(ms). 기록이 없으면 0. */
  readonly quietMs: number;
  /** 판정에 쓴 간격(ms). 화면이 "N분마다 돕니다" 를 말하는 데 쓴다. */
  readonly intervalMs: number;
  /** 운영 시간대를 알고 있는가. 모르면 24시간으로 봤다는 뜻이다. */
  readonly knowsHours: boolean;
}

/**
 * 마지막 회차 시각으로 수집기 상태를 판정한다. 순수 함수다.
 *
 * `lastRunAt` 은 **시작 시각**이다. 끝난 시각으로 보면 안 된다 — 지금 돌고 있는 회차는
 * 끝난 시각이 없어서, 한창 일하는 중인 수집기를 "멈췄다" 고 말하게 된다.
 */
export function judgeCollector(input: {
  readonly lastRunAt: number | null;
  readonly now: number;
  readonly intervalMs: number;
  readonly hoursSpec: string;
}): CollectorJudgement {
  const intervalMs = Number.isFinite(input.intervalMs) && input.intervalMs > 0
    ? input.intervalMs
    : DEFAULT_COLLECT_INTERVAL_MS;
  const knowsHours = input.hoursSpec.trim() !== "";
  const resting = !isWithinHours(new Date(input.now), input.hoursSpec);

  if (input.lastRunAt === null) {
    // 한 번도 돈 적이 없다. 운영 시간대 밖이어도 이건 "쉬는 중" 이 아니다 —
    // 설치가 안 끝났거나 수집기가 한 번도 뜨지 못한 것이다.
    return { state: "never", quietMs: 0, intervalMs, knowsHours };
  }

  const quietMs = Math.max(0, input.now - input.lastRunAt);
  if (resting) return { state: "resting", quietMs, intervalMs, knowsHours };
  return {
    state: quietMs > intervalMs * STALL_FACTOR ? "stalled" : "ok",
    quietMs,
    intervalMs,
    knowsHours,
  };
}

/**
 * 수집기에 재로그인을 요청하는 것이 뜻이 있는가.
 *
 * 멈춰 있거나 한 번도 안 돌았으면 요청은 줄에 남아 아무 일도 일어나지 않는다. 그때
 * 버튼을 보여 주면 사람은 누르고 기다린다 — 그게 이 판정이 필요한 이유다.
 *
 * 쉬는 중(운영 시간대 밖)에는 **뜻이 있다.** worker 는 자는 동안에도 요청을 보고
 * 깨어난다(collector/worker.ts) — 간격만 기다리면 된다.
 */
export function canAskCollector(state: CollectorState): boolean {
  return state === "ok" || state === "resting";
}

/* ------------------------------------------------------------------ *
 * DB 에서 읽기
 * ------------------------------------------------------------------ */

/** 화면에 넘길 모양. 시각은 ISO 문자열로 준다(클라이언트가 자기 시계로 그린다). */
export interface CollectorHealth extends CollectorJudgement {
  readonly lastRunAt: string;
  /** 마지막으로 **성공한** 회차. 실패만 반복하는 상태를 "ok" 로 보여주지 않으려고 함께 준다. */
  readonly lastSuccessAt: string;
  /** 요청을 남기는 것이 뜻이 있는가. */
  readonly canAsk: boolean;
}

interface RunStamp {
  started_at: string | null;
}

/**
 * 마지막 회차로 수집기 상태를 읽는다.
 *
 * 간격·운영 시간대는 **이 앱의 환경변수**에서 읽는다. worker 와 같은 값이 웹에도 들어
 * 있어야 판정이 정확하다(manifest.yml). 없으면 기본 간격·24시간으로 본다 — 그 경우
 * 밤중에 "멈춤" 이 뜰 수 있어서 화면이 그 가능성을 함께 말한다(knowsHours).
 */
export async function readCollectorHealth(db: {
  get: <T>(sql: string, args?: readonly unknown[]) => Promise<T | undefined | null>;
}): Promise<CollectorHealth> {
  const last = await db.get<RunStamp>(
    "SELECT started_at FROM runs ORDER BY run_id DESC LIMIT 1",
  );
  const success = await db.get<RunStamp>(
    "SELECT started_at FROM runs WHERE status = 'success' ORDER BY run_id DESC LIMIT 1",
  );

  const lastRunAt = last?.started_at ?? "";
  const parsed = lastRunAt === "" ? Number.NaN : Date.parse(lastRunAt);
  const judgement = judgeCollector({
    lastRunAt: Number.isFinite(parsed) ? parsed : null,
    now: Date.now(),
    intervalMs: Number(process.env.SR_COLLECT_INTERVAL_MS ?? "") || DEFAULT_COLLECT_INTERVAL_MS,
    hoursSpec: (process.env.SR_COLLECT_HOURS ?? "").trim(),
  });

  return {
    ...judgement,
    lastRunAt,
    lastSuccessAt: success?.started_at ?? "",
    canAsk: canAskCollector(judgement.state),
  };
}
