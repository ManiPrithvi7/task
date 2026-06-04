import { DeferredDeviceWorkQueue } from '@/services/deferredDeviceWork';

describe('DeferredDeviceWorkQueue', () => {
  it('dedupes connect_refresh by deviceId', async () => {
    const q = new DeferredDeviceWorkQueue();
    q.enqueueConnectRefresh('DEVICE-1');
    q.enqueueConnectRefresh('DEVICE-1');
    expect(q.pendingCount()).toBe(1);

    const processed: string[] = [];
    await q.processAll(async (item) => {
      processed.push(item.deviceId);
    });
    expect(processed).toEqual(['DEVICE-1']);
  });

  it('skips stale work older than 30s', async () => {
    const q = new DeferredDeviceWorkQueue();
    (q as unknown as { queue: { type: string; deviceId: string; enqueuedAt: number }[] }).queue.push({
      type: 'connect_refresh',
      deviceId: 'DEVICE-OLD',
      enqueuedAt: Date.now() - 31_000
    });

    const processed: string[] = [];
    const result = await q.processAll(async (item) => {
      processed.push(item.deviceId);
    });

    expect(processed).toHaveLength(0);
    expect(result.skippedStale).toBe(1);
  });

  it('single-flight prevents concurrent processAll', async () => {
    const q = new DeferredDeviceWorkQueue();
    q.enqueueConnectRefresh('DEVICE-1');

    let resolveFirst: () => void = () => undefined;
    const first = q.processAll(async () => {
      await new Promise<void>((r) => {
        resolveFirst = r;
      });
    });

    const second = await q.processAll(async () => undefined);
    expect(second.processed).toBe(0);

    resolveFirst();
    await first;
  });
});
