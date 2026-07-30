export interface BudgetTracker {
  recordCall(): Promise<void>;
  isExhausted(limit: number): Promise<boolean>;
}

export interface CircuitGate {
  isOpen(): Promise<boolean>;
  open(secs: number, reason: string): Promise<void>;
  reset(): Promise<void>;
}

export interface DeviceBackoff {
  shouldAllow(deviceId: string): Promise<boolean>;
  recordSuccess(deviceId: string): Promise<void>;
  recordError(deviceId: string, status?: number): Promise<void>;
}

export interface FetchDedupe {
  tryAcquire(deviceId: string, windowMs: number): Promise<boolean>;
}

export interface FairOffset {
  next(deviceCount: number): Promise<number>;
}

/** Sliding-window rate limit — matches fetch_history Lua semantics. */
export class LocalDeviceBackoff implements DeviceBackoff {
  private attempts = new Map<string, number[]>();

  constructor(
    private readonly threshold: number,
    private readonly windowMs: number
  ) {}

  async shouldAllow(deviceId: string): Promise<boolean> {
    const now = Date.now();
    const start = now - this.windowMs;
    const list = (this.attempts.get(deviceId) ?? []).filter((t) => t >= start);
    if (list.length >= this.threshold) return false;
    list.push(now);
    this.attempts.set(deviceId, list);
    return true;
  }

  async recordSuccess(_deviceId: string): Promise<void> {}

  async recordError(deviceId: string, _status?: number): Promise<void> {
    const list = this.attempts.get(deviceId);
    if (list && list.length > 0) list.pop();
  }
}

export class LocalBudgetTracker implements BudgetTracker {
  private slot = 0;
  private count = 0;

  private rollSlot(): void {
    const nowSlot = Math.floor(Date.now() / 60_000);
    if (nowSlot !== this.slot) {
      this.slot = nowSlot;
      this.count = 0;
    }
  }

  async recordCall(): Promise<void> {
    this.rollSlot();
    this.count++;
  }

  async isExhausted(limit: number): Promise<boolean> {
    if (!limit || limit <= 0) return false;
    this.rollSlot();
    return this.count > limit;
  }
}

export class LocalCircuitGate implements CircuitGate {
  private blockedUntil = 0;

  async isOpen(): Promise<boolean> {
    return this.blockedUntil > Date.now();
  }

  async open(secs: number, _reason: string): Promise<void> {
    this.blockedUntil = Date.now() + Math.max(1, Math.floor(secs)) * 1000;
  }

  async reset(): Promise<void> {
    this.blockedUntil = 0;
  }
}

export class LocalFetchDedupe implements FetchDedupe {
  private last = new Map<string, number>();

  async tryAcquire(deviceId: string, windowMs: number): Promise<boolean> {
    if (!windowMs || windowMs <= 0) return true;
    const now = Date.now();
    const prev = this.last.get(deviceId) ?? 0;
    if (now - prev < windowMs) return false;
    this.last.set(deviceId, now);
    return true;
  }
}

export class LocalFairOffset implements FairOffset {
  private offset = 0;

  async next(deviceCount: number): Promise<number> {
    if (deviceCount <= 0) return 0;
    const start = this.offset % deviceCount;
    this.offset = (this.offset + 1) % deviceCount;
    return start;
  }
}

/** Record call then check limit (matches poller order). */
export async function consumeFetchBudget(budget: BudgetTracker, limit: number): Promise<boolean> {
  await budget.recordCall();
  return !(await budget.isExhausted(limit));
}
