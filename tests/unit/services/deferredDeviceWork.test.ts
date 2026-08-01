import {
  DeferredDeviceWorkQueue,
  isDeferredWorkRearmEnabled,
  resolveOtaRegistrationDeferConcurrency
} from '@/services/deferredDeviceWork';

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

  it('empty queue returns zeroed drain result', async () => {
    const q = new DeferredDeviceWorkQueue();
    const result = await q.processAll(async () => undefined);
    expect(result).toEqual({
      pendingBefore: 0,
      processed: 0,
      skippedStale: 0,
      failed: 0,
      requeued: 0,
      pendingAfter: 0,
      rearmed: false
    });
  });

  it('mixed stale+fresh: processes fresh, counts stale', async () => {
    const q = new DeferredDeviceWorkQueue();
    const now = Date.now();
    (q as unknown as { queue: unknown[] }).queue.push(
      { type: 'connect_refresh', deviceId: 'OLD', enqueuedAt: now - 31_000, attempts: 0 },
      { type: 'connect_refresh', deviceId: 'NEW', enqueuedAt: now, attempts: 0 }
    );
    const processed: string[] = [];
    const result = await q.processAll(async (item) => {
      processed.push(item.deviceId);
    });
    expect(processed).toEqual(['NEW']);
    expect(result.skippedStale).toBe(1);
    expect(result.processed).toBe(1);
  });

  it('processes all connect_refresh before ota_registration', async () => {
    const q = new DeferredDeviceWorkQueue();
    q.enqueueOtaRegistration('OTA-1', '1.0.0');
    q.enqueueConnectRefresh('CONN-1');
    q.enqueueOtaRegistration('OTA-2', '2.0.0');
    q.enqueueConnectRefresh('CONN-2');

    const order: string[] = [];
    await q.processAll(async (item) => {
      order.push(`${item.type}:${item.deviceId}`);
    });
    expect(order).toEqual([
      'connect_refresh:CONN-1',
      'connect_refresh:CONN-2',
      'ota_registration:OTA-1',
      'ota_registration:OTA-2'
    ]);
  });

  it('drops item that already has attempts=1 without requeue', async () => {
    const q = new DeferredDeviceWorkQueue();
    (q as unknown as { queue: unknown[] }).queue.push({
      type: 'connect_refresh',
      deviceId: 'DEVICE-1',
      enqueuedAt: Date.now(),
      attempts: 1
    });
    const result = await q.processAll(async () => {
      throw new Error('fail again');
    });
    expect(result.failed).toBe(1);
    expect(result.requeued).toBe(0);
    expect(result.pendingAfter).toBe(0);
    expect(q.pendingCount()).toBe(0);
  });

  it('trims connect deviceId and noops blank', () => {
    const q = new DeferredDeviceWorkQueue();
    q.enqueueConnectRefresh('  ');
    expect(q.pendingCount()).toBe(0);
    q.enqueueConnectRefresh(' DEV-1 ');
    q.enqueueConnectRefresh('DEV-1');
    expect(q.pendingCount()).toBe(1);
  });

  it('trims ota fields and noops blank id or version', () => {
    const q = new DeferredDeviceWorkQueue();
    q.enqueueOtaRegistration('  ', '1.0.0');
    q.enqueueOtaRegistration('DEV-1', '  ');
    expect(q.pendingCount()).toBe(0);
    q.enqueueOtaRegistration(' DEV-1 ', ' 1.0.1 ');
    expect(q.pendingCount()).toBe(1);
  });

  it('clamps otaRegistrationConcurrency 0 to 1', async () => {
    const q = new DeferredDeviceWorkQueue();
    q.enqueueOtaRegistration('D0', '1.0.0');
    q.enqueueOtaRegistration('D1', '1.0.0');
    let inFlight = 0;
    let maxInFlight = 0;
    await q.processAll(
      async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight -= 1;
      },
      { otaRegistrationConcurrency: 0 }
    );
    expect(maxInFlight).toBe(1);
  });
});

describe('resolveOtaRegistrationDeferConcurrency', () => {
  const prev = process.env.OTA_REGISTRATION_DEFER_CONCURRENCY;
  afterEach(() => {
    if (prev === undefined) delete process.env.OTA_REGISTRATION_DEFER_CONCURRENCY;
    else process.env.OTA_REGISTRATION_DEFER_CONCURRENCY = prev;
  });

  it('defaults to 10', () => {
    delete process.env.OTA_REGISTRATION_DEFER_CONCURRENCY;
    expect(resolveOtaRegistrationDeferConcurrency()).toBe(10);
  });

  it('parses positive int', () => {
    process.env.OTA_REGISTRATION_DEFER_CONCURRENCY = '5';
    expect(resolveOtaRegistrationDeferConcurrency()).toBe(5);
  });

  it('falls back to 10 for invalid', () => {
    process.env.OTA_REGISTRATION_DEFER_CONCURRENCY = 'abc';
    expect(resolveOtaRegistrationDeferConcurrency()).toBe(10);
    process.env.OTA_REGISTRATION_DEFER_CONCURRENCY = '0';
    expect(resolveOtaRegistrationDeferConcurrency()).toBe(10);
  });
});

describe('isDeferredWorkRearmEnabled', () => {
  const prev = process.env.DEFERRED_WORK_REARM;
  afterEach(() => {
    if (prev === undefined) delete process.env.DEFERRED_WORK_REARM;
    else process.env.DEFERRED_WORK_REARM = prev;
  });

  it('defaults to true; exact false disables', () => {
    delete process.env.DEFERRED_WORK_REARM;
    expect(isDeferredWorkRearmEnabled()).toBe(true);
    process.env.DEFERRED_WORK_REARM = 'false';
    expect(isDeferredWorkRearmEnabled()).toBe(false);
    process.env.DEFERRED_WORK_REARM = 'FALSE';
    expect(isDeferredWorkRearmEnabled()).toBe(true);
  });
});
