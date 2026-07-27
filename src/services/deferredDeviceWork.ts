export type DeferredWorkItem =
  | {
      type: 'connect_refresh';
      deviceId: string;
      enqueuedAt: number;
      attempts: number;
    }
  | {
      type: 'ota_registration';
      deviceId: string;
      currentVersion: string;
      enqueuedAt: number;
      attempts: number;
    };

export type DeferredDrainResult = {
  pendingBefore: number;
  processed: number;
  skippedStale: number;
  failed: number;
  requeued: number;
  pendingAfter: number;
  rearmed: boolean;
};

const STALE_MS = 30_000;
const DEFAULT_OTA_REGISTRATION_CONCURRENCY = 10;
/** Initial attempt + one retry after failure. */
const MAX_ATTEMPTS = 2;

export function resolveOtaRegistrationDeferConcurrency(): number {
  const raw = process.env.OTA_REGISTRATION_DEFER_CONCURRENCY;
  if (!raw?.trim()) return DEFAULT_OTA_REGISTRATION_CONCURRENCY;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_OTA_REGISTRATION_CONCURRENCY;
}

/** Rollback: set DEFERRED_WORK_REARM=false to disable post-drain re-arm. Default on. */
export function isDeferredWorkRearmEnabled(): boolean {
  return process.env.DEFERRED_WORK_REARM !== 'false';
}

export class DeferredDeviceWorkQueue {
  private queue: DeferredWorkItem[] = [];
  private processing = false;
  /** Set when enqueue or processAll occurs while a drain is in flight. */
  private rearmRequested = false;

  enqueueConnectRefresh(deviceId: string): void {
    const trimmed = deviceId.trim();
    if (!trimmed) return;

    if (this.processing) this.rearmRequested = true;

    this.queue = this.queue.filter(
      (w) => !(w.type === 'connect_refresh' && w.deviceId === trimmed)
    );
    this.queue.push({
      type: 'connect_refresh',
      deviceId: trimmed,
      enqueuedAt: Date.now(),
      attempts: 0
    });
  }

  enqueueOtaRegistration(deviceId: string, currentVersion: string): void {
    const trimmedId = deviceId.trim();
    const trimmedVersion = currentVersion.trim();
    if (!trimmedId || !trimmedVersion) return;

    if (this.processing) this.rearmRequested = true;

    this.queue = this.queue.filter(
      (w) => !(w.type === 'ota_registration' && w.deviceId === trimmedId)
    );
    this.queue.push({
      type: 'ota_registration',
      deviceId: trimmedId,
      currentVersion: trimmedVersion,
      enqueuedAt: Date.now(),
      attempts: 0
    });
  }

  pendingCount(): number {
    return this.queue.length;
  }

  async processAll(
    handler: (item: DeferredWorkItem) => Promise<void>,
    options?: { otaRegistrationConcurrency?: number }
  ): Promise<DeferredDrainResult> {
    if (this.processing) {
      this.rearmRequested = true;
      return {
        pendingBefore: this.queue.length,
        processed: 0,
        skippedStale: 0,
        failed: 0,
        requeued: 0,
        pendingAfter: this.queue.length,
        rearmed: true
      };
    }

    this.processing = true;
    this.rearmRequested = false;
    const pendingBefore = this.queue.length;
    let processed = 0;
    let skippedStale = 0;
    let failed = 0;
    let requeued = 0;

    try {
      const now = Date.now();
      const pending = [...this.queue];
      this.queue = [];

      const fresh: DeferredWorkItem[] = [];
      for (const item of pending) {
        if (now - item.enqueuedAt <= STALE_MS) {
          fresh.push(item);
        } else {
          skippedStale++;
        }
      }

      const connectItems = fresh.filter((item) => item.type === 'connect_refresh');
      const otaItems = fresh.filter((item) => item.type === 'ota_registration');
      const otaConcurrency = Math.max(
        1,
        options?.otaRegistrationConcurrency ?? resolveOtaRegistrationDeferConcurrency()
      );

      const runOne = async (item: DeferredWorkItem): Promise<void> => {
        try {
          await handler(item);
          processed++;
        } catch {
          failed++;
          const nextAttempts = (item.attempts ?? 0) + 1;
          if (nextAttempts < MAX_ATTEMPTS) {
            requeued++;
            // Refresh enqueuedAt so retry is not immediately stale under slow drains.
            if (item.type === 'connect_refresh') {
              this.queue.push({
                ...item,
                attempts: nextAttempts,
                enqueuedAt: Date.now()
              });
            } else {
              this.queue.push({
                ...item,
                attempts: nextAttempts,
                enqueuedAt: Date.now()
              });
            }
            this.rearmRequested = true;
          }
        }
      };

      for (const item of connectItems) {
        await runOne(item);
      }

      let otaIndex = 0;
      const runOtaWorker = async (): Promise<void> => {
        while (otaIndex < otaItems.length) {
          const item = otaItems[otaIndex++];
          await runOne(item);
        }
      };

      const workerCount = Math.min(otaConcurrency, otaItems.length);
      await Promise.all(Array.from({ length: workerCount }, () => runOtaWorker()));
    } finally {
      this.processing = false;
    }

    const pendingAfter = this.queue.length;
    const rearmed = this.rearmRequested || pendingAfter > 0;

    return {
      pendingBefore,
      processed,
      skippedStale,
      failed,
      requeued,
      pendingAfter,
      rearmed
    };
  }
}
