/**
 * worker 스케줄 순수 함수.
 *
 * argv/시그널/spawn 같은 부작용과 분리해 밀폐 테스트가 가능하도록 뽑았다.
 * 여기 있는 함수는 입력 → 출력만 하는 순수 함수다(시간·환경·IO 를 만지지 않는다).
 */

/** 밀리초 설정값 검증 결과. */
export interface DurationResult {
  /** 채택된 값(ms). 입력이 부적절하면 fallback. */
  readonly value: number;
  /** 부적절해서 fallback 을 쓴 경우의 사유(정상이면 null). 로그는 호출부가 남긴다. */
  readonly warning: string | null;
}

/**
 * 환경변수 등에서 온 ms 설정값을 [min, max] 범위로 검증한다(순수 함수).
 *
 * - 미설정/빈문자열 → fallback (경고 없음: 기본값을 쓰는 정상 경로).
 * - 숫자가 아니거나 범위를 벗어남 → fallback + 사유 문자열.
 *   하한(min)만이 아니라 상한(max)도 검사한다. setTimeout 은 2^31-1ms 를 넘는 지연을
 *   1ms 로 클램프해 tight loop 를 유발하므로, 상한을 넘긴 값을 그대로 쓰면 위험하다.
 * - 정상 범위 → 정수화한 값(소수점 버림).
 */
export function resolveDurationMs(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): DurationResult {
  if (raw === undefined || raw.trim() === "") {
    return { value: fallback, warning: null };
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return {
      value: fallback,
      warning: `허용 범위(${min}–${max}ms)를 벗어나 기본값(${fallback}ms)을 씁니다: ${raw.trim()}`,
    };
  }

  return { value: Math.floor(parsed), warning: null };
}

/** 운영 시간대 파싱 결과. start·end 는 '시(hour)' 단위 정수. */
export interface HoursRange {
  /** 시작 시(포함). 0–23. */
  readonly start: number;
  /** 종료 시(제외). 0–24. */
  readonly end: number;
}

/**
 * "8-20" 형태의 운영 시간대 스펙을 파싱한다.
 *
 * start 는 0–23, end 는 0–24(24 = 자정) 범위의 정수여야 한다.
 * 형식이 틀리거나 범위를 벗어나면 null 을 돌려준다 — 호출부가 '항상 실행'으로
 * 안전하게(fail-open) 떨어질 수 있게.
 */
export function parseHours(spec: string): HoursRange | null {
  if (typeof spec !== "string") return null;

  const match = spec.trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (match === null) return null;

  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || start > 23) return null;
  if (end < 0 || end > 24) return null;

  return { start, end };
}

/**
 * 주어진 시각이 운영 시간대 안인지 판정한다.
 *
 * 경계 규칙: **start ≤ hour < end** (시작 시는 포함, 종료 시는 제외).
 *   예) "8-20" → 8:00–19:59 는 안, 20:00 은 밖.
 *
 * - spec 이 미설정/빈문자열이면 항상 true(운영 시간대 제한 없음 = 24시간).
 * - spec 형식이 잘못됐으면 true(fail-open) — 설정 오타로 수집이 통째로 멈추는 것보다
 *   계속 도는 쪽이 이 수집기의 목적에 안전하다. (worker 는 시작 시 한 번 경고를 남긴다.)
 * - start > end 이면 자정을 넘는 야간 구간으로 본다. 예) "20-6" → 20:00–05:59.
 * - start === end 이면 구분이 모호하므로 항상 true 로 둔다.
 */
export function isWithinHours(date: Date, spec: string): boolean {
  if (spec === undefined || spec === null || spec.trim() === "") return true;

  const range = parseHours(spec);
  if (range === null) return true;

  const hour = date.getHours();
  const { start, end } = range;

  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  // 야간 랩어라운드: [start, 24) ∪ [0, end)
  return hour >= start || hour < end;
}
