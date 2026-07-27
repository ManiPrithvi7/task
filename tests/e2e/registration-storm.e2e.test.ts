import { DeferredDeviceWorkQueue } from '@/services/deferredDeviceWork';

/**
 * Registration storm (logic): many concurrent /active-equivalent enqueues
 * must dedupe, respect concurrency, and re-arm after enqueue-during-drain.
 */
describe('E2E registration storm (deferred queue logic)', () => {
  it('dedupes concurrent ota_registration enqueues under storm', async () => {
    const q = new DeferredDeviceWorkQueue();
    const deviceCount = 50;
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < deviceCount; i += 1) {
        q.enqueueOtaRegistration(`DEVICE-${i}`, `1.0.${round}`);
      }
    }
    expect(q.pendingCount()).toBe(deviceCount);

    const delivered = new Map<string, string>();
    let inFlight = 0;
    let maxInFlight = 0;

    await q.processAll(
      async (item) => {
        if (item.type !== 'ota_registration') return;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        delivered.set(item.deviceId, item.currentVersion);
        inFlight -= 1;
      },
      { otaRegistrationConcurrency: 10 }
    );

    expect(delivered.size).toBe(deviceCount);
    expect(maxInFlight).toBeLessThanOrEqual(10);
    for (let i = 0; i < deviceCount; i += 1) {
      expect(delivered.get(`DEVICE-${i}`)).toBe('1.0.2');
    }
  });

  it('second drain processes work enqueued during first drain', async () => {
    const q = new DeferredDeviceWorkQueue();
    q.enqueueConnectRefresh('DEVICE-A');

    let unlock: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      unlock = r;
    });

    const first = q.processAll(async (item) => {
      if (item.deviceId === 'DEVICE-A') {
        q.enqueueOtaRegistration('DEVICE-B', '2.0.0');
        await gate;
      }
    });

    await new Promise((r) => setTimeout(r, 5));
    unlock();
    const firstResult = await first;
    expect(firstResult.rearmed).toBe(true);
    expect(q.pendingCount()).toBe(1);

    const seen: string[] = [];
    const second = await q.processAll(async (item) => {
      seen.push(`${item.type}:${item.deviceId}`);
    });
    expect(second.processed).toBe(1);
    expect(seen).toEqual(['ota_registration:DEVICE-B']);
  });
});
