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

export interface OtaFleetTracker {
  isPending(deviceId: string, version: string): Promise<boolean>;
  isDelivered(deviceId: string, version: string): Promise<boolean>;
  markDelivered(deviceId: string, version: string): Promise<void>;
  markPending(deviceId: string, version: string, stage: number): Promise<void>;
  markDeferred(deviceId: string): Promise<void>;
  isDeferred(deviceId: string): Promise<boolean>;
  getPendingDevices(version: string): Promise<string[]>;
  getDeliveredDevices(version: string): Promise<string[]>;
  getActiveRelease(): Promise<string>;
  setActiveRelease(version: string): Promise<void>;
  getRolloutPercentage(): Promise<number>;
  setRolloutPercentage(pct: number): Promise<void>;
  shouldDeliverOta(deviceId: string, activeRelease: string): Promise<boolean>;
  setActiveDevices(devices: string[], registeredAt: Map<string, number>): void;
  getDevicesForRollout(percentage: number, version: string): string[];
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

type OtaStatusReader = (deviceId: string) => string | undefined;

/** Local fleet tracker — FIFO + version rotation; Redis adapters can swap later. */
export class LocalOtaFleetTracker implements OtaFleetTracker {
  private pending = new Map<string, Set<string>>(); // version → deviceIds
  private delivered = new Map<string, Set<string>>();
  private deferred = new Set<string>();
  private activeRelease = '';
  private rolloutPercentage = 0;
  private activeDevices: string[] = [];
  private registeredAt = new Map<string, number>();
  private statusReader: OtaStatusReader;

  constructor(statusReader?: OtaStatusReader) {
    this.statusReader = statusReader ?? (() => undefined);
  }

  setStatusReader(reader: OtaStatusReader): void {
    this.statusReader = reader;
  }

  async isPending(deviceId: string, version: string): Promise<boolean> {
    return this.pending.get(version)?.has(deviceId) ?? false;
  }

  async isDelivered(deviceId: string, version: string): Promise<boolean> {
    return this.delivered.get(version)?.has(deviceId) ?? false;
  }

  async markDelivered(deviceId: string, version: string): Promise<void> {
    this.pending.get(version)?.delete(deviceId);
    let set = this.delivered.get(version);
    if (!set) {
      set = new Set();
      this.delivered.set(version, set);
    }
    set.add(deviceId);
    this.deferred.delete(deviceId);
  }

  async markPending(deviceId: string, version: string, _stage: number): Promise<void> {
    let set = this.pending.get(version);
    if (!set) {
      set = new Set();
      this.pending.set(version, set);
    }
    set.add(deviceId);
  }

  seedPendingFleet(version: string, deviceIds: string[]): void {
    this.pending.set(version, new Set(deviceIds));
  }

  clearPendingFleet(version: string): void {
    this.pending.delete(version);
  }

  filterPending(version: string, deviceIds: string[]): string[] {
    const set = this.pending.get(version);
    if (!set || set.size === 0) return [];
    return deviceIds.filter((id) => set.has(id));
  }

  async markDeferred(deviceId: string): Promise<void> {
    this.deferred.add(deviceId);
  }

  async isDeferred(deviceId: string): Promise<boolean> {
    return this.deferred.has(deviceId);
  }

  async getPendingDevices(version: string): Promise<string[]> {
    return [...(this.pending.get(version) ?? [])];
  }

  async getDeliveredDevices(version: string): Promise<string[]> {
    return [...(this.delivered.get(version) ?? [])];
  }

  async getActiveRelease(): Promise<string> {
    return this.activeRelease;
  }

  async setActiveRelease(version: string): Promise<void> {
    this.activeRelease = version;
  }

  async getRolloutPercentage(): Promise<number> {
    return this.rolloutPercentage;
  }

  async setRolloutPercentage(pct: number): Promise<void> {
    this.rolloutPercentage = Math.max(0, Math.min(100, pct));
  }

  async shouldDeliverOta(deviceId: string, activeRelease: string): Promise<boolean> {
    if (!activeRelease) return false;
    if (await this.isDelivered(deviceId, activeRelease)) return false;
    if (await this.isDeferred(deviceId)) return false;
    const status = this.statusReader(deviceId);
    if (status === 'succeeded' || status === 'delivered') return false;
    return true;
  }

  setActiveDevices(devices: string[], registeredAt: Map<string, number>): void {
    this.activeDevices = [...devices];
    this.registeredAt = new Map(registeredAt);
  }

  getDevicesForRollout(percentage: number, version: string): string[] {
    if (percentage >= 100) {
      return this.activeDevices.filter((id) => {
        const status = this.statusReader(id);
        return status !== 'succeeded' && status !== 'delivered';
      });
    }
    if (percentage <= 0) return [];

    const eligible = this.activeDevices.filter((id) => {
      const status = this.statusReader(id);
      return status !== 'succeeded' && status !== 'delivered';
    });

    const sorted = [...eligible].sort(
      (a, b) => (this.registeredAt.get(a) ?? 0) - (this.registeredAt.get(b) ?? 0)
    );

    if (sorted.length === 0) return [];

    const [major, minor] = version.split('.').map(Number);
    const offset = ((major || 0) * 100 + (minor || 0)) % sorted.length;

    const rotated = [...sorted.slice(offset), ...sorted.slice(0, offset)];
    const count = Math.max(1, Math.ceil((rotated.length * percentage) / 100));
    return rotated.slice(0, count);
  }
}

let localOtaFleet: LocalOtaFleetTracker | null = null;

export function getLocalOtaFleetTracker(): LocalOtaFleetTracker {
  if (!localOtaFleet) localOtaFleet = new LocalOtaFleetTracker();
  return localOtaFleet;
}

export function resetLocalOtaFleetTrackerForTests(): void {
  localOtaFleet = null;
}
