export type DeferredWorkItem = {
  type: 'connect_refresh';
  deviceId: string;
  enqueuedAt: number;
};

const STALE_MS = 30_000;

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

  pendingCount(): number {
    return this.queue.length;
  }

  async processAll(
    handler: (item: DeferredWorkItem) => Promise<void>
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

      for (const item of pending) {
        if (now - item.enqueuedAt > STALE_MS) {
          skippedStale++;
          continue;
        }

        try {
          await handler(item);
          processed++;
        } catch {
          failed++;
        }
      }
    } finally {
      this.processing = false;
    }

    return { processed, skippedStale, failed };
  }
}
