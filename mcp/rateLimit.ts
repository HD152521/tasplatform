/**
 * 인증 실패 무차별 대입 방지 (Step 4 보안 캐리).
 *
 * 아주 단순한 in-memory 카운터다. 같은 출처(보통 remote address)에서 짧은 시간
 * 동안 인증 실패가 반복되면 일정 시간 그 출처를 막는다. 프로세스 재시작으로
 * 초기화돼도 괜찮다 — 목적은 완벽한 방어가 아니라 값싼 무차별 시도를 늦추는 것.
 *
 * now 를 주입받을 수 있게 한 것은 테스트에서 실제 타이머 없이 시간 경과를
 * 흉내 내기 위해서다. 실제 서버는 기본값(Date.now)을 그대로 쓴다.
 *
 * 메모리 무한 증가 방지(Step 4 보안 리뷰 MEDIUM 캐리):
 * 서로 다른 출처(IP)로 실패가 계속 들어오면 entries Map 이 끝없이 자랄 수 있다.
 * 그래서 두 겹으로 막는다.
 *   1) lazy sweep: isBlocked/recordFailure 호출마다, 마지막 청소 이후
 *      sweepIntervalMs 가 지났으면 만료된(차단도 안 끝나고 창도 지난) 엔트리를 지운다.
 *      매 호출마다 전체를 훑지 않도록 주기로 제한한다.
 *   2) 상한: sweep 뒤에도 maxEntries 를 넘으면, windowStart 가 가장 오래된 것부터
 *      지워 상한 아래로 맞춘다 — 폭주하는 공격이 sweep 주기 사이에 몰려도 무한정
 *      자라지 못하게 하는 값싼 안전장치다.
 */
export interface RateLimitOptions {
  /** 이 횟수만큼 실패하면 차단한다. */
  maxFailures: number;
  /** 이 시간 안에 일어난 실패만 같은 회차로 센다. */
  windowMs: number;
  /** 차단 지속 시간. */
  blockMs: number;
  /** 만료된 엔트리를 청소하는 주기. */
  sweepIntervalMs: number;
  /** 이 개수를 넘으면 가장 오래된 것부터 강제로 지운다(폭주 시 상한). */
  maxEntries: number;
}

const DEFAULT_OPTIONS: RateLimitOptions = {
  maxFailures: 5,
  windowMs: 60_000,
  blockMs: 60_000,
  sweepIntervalMs: 60_000,
  maxEntries: 10_000,
};

interface Entry {
  count: number;
  windowStart: number;
  blockedUntil: number;
}

export class AuthRateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly options: RateLimitOptions;
  private lastSweepAt = 0;

  constructor(options: Partial<RateLimitOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** 테스트/관측용. 실제 서버 로직은 이 값을 쓰지 않는다. */
  get size(): number {
    return this.entries.size;
  }

  /** 지금 이 출처가 차단돼 있는가. */
  isBlocked(key: string, now: number = Date.now()): boolean {
    this.maybeCleanup(now);
    const entry = this.entries.get(key);
    if (!entry) return false;
    return entry.blockedUntil > now;
  }

  /** 인증 실패를 기록한다. 창(window) 안에서 상한을 넘기면 차단을 건다. */
  recordFailure(key: string, now: number = Date.now()): void {
    this.maybeCleanup(now);

    const entry = this.entries.get(key);
    if (!entry || now - entry.windowStart > this.options.windowMs) {
      this.entries.set(key, { count: 1, windowStart: now, blockedUntil: 0 });
    } else {
      const count = entry.count + 1;
      const blockedUntil =
        count >= this.options.maxFailures ? now + this.options.blockMs : entry.blockedUntil;
      this.entries.set(key, { count, windowStart: entry.windowStart, blockedUntil });
    }

    this.enforceMaxEntries();
  }

  /** 인증 성공 시 그 출처의 실패 이력을 지운다. */
  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  /** 차단도 끝났고 실패 창도 지난, 더 이상 의미 없는 엔트리인가. */
  private isExpired(entry: Entry, now: number): boolean {
    if (entry.blockedUntil > now) return false; // 아직 차단 중이면 지우면 안 된다
    return now - entry.windowStart > this.options.windowMs;
  }

  /** 주기가 지났을 때만 전체를 훑는다 — 매 호출마다 O(n) 을 물지 않기 위해서다. */
  private maybeCleanup(now: number): void {
    if (now - this.lastSweepAt < this.options.sweepIntervalMs) return;
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry, now)) this.entries.delete(key);
    }
    this.lastSweepAt = now;
  }

  /** sweep 으로도 못 막을 만큼 짧은 시간에 몰리는 경우를 대비한 값싼 상한. */
  private enforceMaxEntries(): void {
    const over = this.entries.size - this.options.maxEntries;
    if (over <= 0) return;

    const oldestFirst = [...this.entries.entries()].sort(
      (a, b) => a[1].windowStart - b[1].windowStart,
    );
    for (let i = 0; i < over; i += 1) {
      const key = oldestFirst[i]?.[0];
      if (key !== undefined) this.entries.delete(key);
    }
  }
}
