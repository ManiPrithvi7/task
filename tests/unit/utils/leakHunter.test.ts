import { cachedQuery, clearInfluxQueryCache, influxQueryCacheSize } from '@/services/influxQueryCache';
import {
  collectLeakDiagnostics,
  diagnoseStores,
  readStoreSizes,
  stopLeakHunter,
  type StoreDelta,
  type StoreReading
} from '@/utils/leakHunter';

describe('leak hunter diagnose', () => {
  afterEach(() => {
    clearInfluxQueryCache();
    stopLeakHunter();
  });

  it('names influxQueryCache when that store grows', async () => {
    expect(influxQueryCacheSize()).toBe(0);
    const prev = readStoreSizes();
    await cachedQuery('leak-hunter-test', async () => ({ n: 1 }));
    const curr = readStoreSizes();
    const d = diagnoseStores(prev, curr, 4096);
    expect(d.suspect).toBe('influxQueryCache');
    expect(
      d.growing.some((g: StoreDelta) => g.file === 'src/services/influxQueryCache.ts' && g.delta === 1)
    ).toBe(true);
  });

  it('marks untracked when RSS rises and stores are flat', () => {
    const stores: StoreReading[] = [
      { key: 'influx.queryCache', module: 'influxQueryCache', file: 'src/services/influxQueryCache.ts', count: 0 }
    ];
    const d = diagnoseStores(stores, stores, 4096);
    expect(d.suspect).toBe('untracked_native_or_heap');
    expect(d.growing).toEqual([]);
  });

  it('collects sizes without payloads', async () => {
    await cachedQuery('leak-hunter-test', async () => ({ n: 1 }));
    const snap = collectLeakDiagnostics({
      mqttPendingAcks: 2,
      deferredPending: 3,
      ingressBuffer: 4
    });
    const stores = snap.stores as Array<{ key: string; count: number }>;
    expect(stores.find((s) => s.key === 'influx.queryCache')?.count).toBe(1);
    expect(stores.find((s) => s.key === 'mqtt.pendingAcks')?.count).toBe(2);
    expect(JSON.stringify(snap)).not.toContain('leak-hunter-test');
    const pipe = snap.igPipeline as Record<string, number>;
    expect(pipe).toEqual(
      expect.objectContaining({
        fetchesEnqueued: expect.any(Number),
        fetchesApplied: expect.any(Number),
        fetchesSucceeded: expect.any(Number),
        fetchesFailed: expect.any(Number),
        fetchesNoCredentials: expect.any(Number),
        lastGraphResponseBytes: expect.any(Number)
      })
    );
    expect(pipe).not.toHaveProperty('lastRawResponse');
    expect(pipe).not.toHaveProperty('mediaBuffers');
  });
});
