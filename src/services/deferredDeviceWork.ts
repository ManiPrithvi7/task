export type DeferredWorkItem =
  | {
      type: 'connect_refresh';
      deviceId: string;
      enqueuedAt: number;
    }
  | {
      type: 'ota_registration';
      deviceId: string;
      currentVersion: string;
      enqueuedAt: number;
    };

const STALE_MS = 30_000;
const DEFAULT_OTA_REGISTRATION_CONCURRENCY = 10;

export function resolveOtaRegistrationDeferConcurrency(): number {
  const raw = process.env.OTA_REGISTRATION_DEFER_CONCURRENCY;
  if (!raw?.trim()) return DEFAULT_OTA_REGISTRATION_CONCURRENCY;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_OTA_REGISTRATION_CONCURRENCY;
}

export class DeferredDeviceWorkQueue {
  private queue: DeferredWorkItem[] = [];
  private processing = false;

  enqueueConnectRefresh(deviceId: string): void {
    const trimmed = deviceId.trim();
    if (!trimmed) return;

    this.queue = this.queue.filter(
      (w) => !(w.type === 'connect_refresh' && w.deviceId === trimmed)
    );
    this.queue.push({
      type: 'connect_refresh',
      deviceId: trimmed,
      enqueuedAt: Date.now()
    });
  }

  enqueueOtaRegistration(deviceId: string, currentVersion: string): void {
    const trimmedId = deviceId.trim();
    const trimmedVersion = currentVersion.trim();
    if (!trimmedId || !trimmedVersion) return;

    this.queue = this.queue.filter(
      (w) => !(w.type === 'ota_registration' && w.deviceId === trimmedId)
    );
    this.queue.push({
      type: 'ota_registration',
      deviceId: trimmedId,
      currentVersion: trimmedVersion,
      enqueuedAt: Date.now()
    });
  }

  pendingCount(): number {
    return this.queue.length;
  }

  async processAll(
    handler: (item: DeferredWorkItem) => Promise<void>,
    options?: { otaRegistrationConcurrency?: number }
  ): Promise<{ processed: number; skippedStale: number; failed: number }> {
    if (this.processing) {
      return { processed: 0, skippedStale: 0, failed: 0 };
    }

    this.processing = true;
    let processed = 0;
    let skippedStale = 0;
    let failed = 0;

    try {
      const now = Date.now();
      const pending = [...this.queue];
      this.queue = [];

      const fresh = pending.filter((item) => {
        if (now - item.enqueuedAt <= STALE_MS) return true;
        skippedStale++;
        return false;
      });

      const connectItems = fresh.filter((item) => item.type === 'connect_refresh');
      const otaItems = fresh.filter((item) => item.type === 'ota_registration');
      const otaConcurrency = Math.max(
        1,
        options?.otaRegistrationConcurrency ?? resolveOtaRegistrationDeferConcurrency()
      );

      for (const item of connectItems) {
        try {
          await handler(item);
          processed++;
        } catch {
          failed++;
        }
      }

      let otaIndex = 0;
      const runOtaWorker = async (): Promise<void> => {
        while (otaIndex < otaItems.length) {
          const item = otaItems[otaIndex++];
          try {
            await handler(item);
            processed++;
          } catch {
            failed++;
          }
        }
      };

      const workerCount = Math.min(otaConcurrency, otaItems.length);
      await Promise.all(Array.from({ length: workerCount }, () => runOtaWorker()));
    } finally {
      this.processing = false;
    }

    return { processed, skippedStale, failed };
  }
}
