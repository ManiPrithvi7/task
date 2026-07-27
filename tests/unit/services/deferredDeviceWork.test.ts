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
    (q as unknown as { queue: { type: string; deviceId: string; enqueuedAt: number; attempts: number }[] }).queue.push({
      type: 'connect_refresh',
      deviceId: 'DEVICE-OLD',
      enqueuedAt: Date.now() - 31_000,
      attempts: 0
    });

    const processed: string[] = [];
    const result = await q.processAll(async (item) => {
      processed.push(item.deviceId);
    });

    expect(processed).toHaveLength(0);
    expect(result.skippedStale).toBe(1);
  });

  it('single-flight marks rearmed when concurrent processAll', async () => {
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
    expect(second.rearmed).toBe(true);

    resolveFirst();
    await first;
  });

  it('enqueue during drain leaves work for second drain', async () => {
    const q = new DeferredDeviceWorkQueue();
    q.enqueueConnectRefresh('DEVICE-1');

    let resolveFirst: () => void = () => undefined;
    const seen: string[] = [];

    const first = q.processAll(async (item) => {
      seen.push(item.deviceId);
      q.enqueueConnectRefresh('DEVICE-2');
      await new Promise<void>((r) => {
        resolveFirst = r;
      });
    });

    // Wait until first item is in handler
    await new Promise((r) => setTimeout(r, 5));
    resolveFirst();
    const firstResult = await first;
    expect(firstResult.rearmed).toBe(true);
    expect(q.pendingCount()).toBe(1);

    const secondResult = await q.processAll(async (item) => {
      seen.push(item.deviceId);
    });
    expect(secondResult.processed).toBe(1);
    expect(seen).toEqual(['DEVICE-1', 'DEVICE-2']);
  });

  it('requeues failed work once then drops', async () => {
    const q = new DeferredDeviceWorkQueue();
    q.enqueueConnectRefresh('DEVICE-1');

    let calls = 0;
    const first = await q.processAll(async () => {
      calls += 1;
      throw new Error('boom');
    });
    expect(first.failed).toBe(1);
    expect(first.requeued).toBe(1);
    expect(q.pendingCount()).toBe(1);

    const second = await q.processAll(async () => {
      calls += 1;
      throw new Error('boom');
    });
    expect(second.failed).toBe(1);
    expect(second.requeued).toBe(0);
    expect(q.pendingCount()).toBe(0);
    expect(calls).toBe(2);
  });

  it('dedupes ota_registration by deviceId', async () => {
    const q = new DeferredDeviceWorkQueue();
    q.enqueueOtaRegistration('DEVICE-1', '1.0.0');
    q.enqueueOtaRegistration('DEVICE-1', '1.0.1');
    expect(q.pendingCount()).toBe(1);

    const processed: string[] = [];
    await q.processAll(async (item) => {
      if (item.type === 'ota_registration') {
        processed.push(`${item.deviceId}:${item.currentVersion}`);
      }
    });
    expect(processed).toEqual(['DEVICE-1:1.0.1']);
  });

  it('processes ota_registration with concurrency cap', async () => {
    const q = new DeferredDeviceWorkQueue();
    for (let i = 0; i < 6; i += 1) {
      q.enqueueOtaRegistration(`DEVICE-${i}`, '1.0.0');
    }

    let inFlight = 0;
    let maxInFlight = 0;
    const processed: string[] = [];

    await q.processAll(
      async (item) => {
        if (item.type !== 'ota_registration') return;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        processed.push(item.deviceId);
        inFlight -= 1;
      },
      { otaRegistrationConcurrency: 2 }
    );

    expect(processed).toHaveLength(6);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(1);
  });
});
