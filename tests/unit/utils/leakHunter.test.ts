import { cachedQuery, clearInfluxQueryCache, influxQueryCacheSize } from '@/services/influxQueryCache';
import {
  collectLeakDiagnostics,
  diagnoseStores,
  parseSmapsRollup,
  parseSmapsTopRss,
  parseStatusVmAndThreads,
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

  it('does not flag a single +2 MB RSS bump as untracked', () => {
    const stores: StoreReading[] = [
      { key: 'influx.queryCache', module: 'influxQueryCache', file: 'src/services/influxQueryCache.ts', count: 0 }
    ];
    const d = diagnoseStores(stores, stores, 4096, 4096);
    expect(d.suspect).toBe('none');
  });

  it('marks untracked when a 10-sample RSS slope exceeds 10 MB', () => {
    const stores: StoreReading[] = [
      { key: 'influx.queryCache', module: 'influxQueryCache', file: 'src/services/influxQueryCache.ts', count: 0 }
    ];
    const d = diagnoseStores(stores, stores, 4096, 12 * 1024);
    expect(d.suspect).toBe('untracked_native_or_heap');
    expect(d.growing).toEqual([]);
  });

  it('collects sizes without payloads', async () => {
    await cachedQuery('leak-hunter-test', async () => ({ n: 1 }));
    const snap = await collectLeakDiagnostics({
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
    const mem = snap.memory as Record<string, number>;
    expect(mem.heapTotal_mb).toEqual(expect.any(Number));
    expect(mem.arrayBuffers_mb).toEqual(expect.any(Number));
    expect(typeof snap.activeDevicesCount).toBe('number');
    const proc = snap.proc as {
      rollup: { rss_kb: number } | null;
      vm_hwm_kb: number | null;
      threads: number | null;
      top_rss: Array<{ name: string; rss_kb: number }>;
    };
    expect(proc.top_rss).toEqual(expect.any(Array));
    if (proc.rollup) {
      expect(proc.rollup.rss_kb).toBeGreaterThan(0);
      expect(proc.threads).toBeGreaterThan(0);
      expect(proc.vm_hwm_kb).toBeGreaterThan(0);
    }
  });

  it('parses smaps_rollup and status fields', () => {
    const rollup = parseSmapsRollup(
      ['Rss:                 640000 kB', 'Pss:                 500000 kB', 'Private_Dirty:       400000 kB', 'Private_Clean:        20000 kB', 'AnonHugePages:            0 kB'].join('\n')
    );
    expect(rollup).toEqual({
      rss_kb: 640000,
      pss_kb: 500000,
      private_dirty_kb: 400000,
      private_clean_kb: 20000,
      anon_huge_pages_kb: 0
    });
    expect(parseStatusVmAndThreads('VmHWM:\t  900000 kB\nThreads:\t18\n')).toEqual({
      vm_hwm_kb: 900000,
      threads: 18
    });
  });

  it('aggregates smaps regions by mapping name', () => {
    const top = parseSmapsTopRss(
      [
        '7f00-7f01 r-xp 00000000 00:00 0 /usr/lib/libssl.so.3',
        'Rss:                   100 kB',
        '7f02-7f03 r-xp 00000000 00:00 0 /usr/lib/libssl.so.3',
        'Rss:                    50 kB',
        '7f04-7f05 rw-p 00000000 00:00 0 [heap]',
        'Rss:                   200 kB',
        '7f06-7f07 rw-p 00000000 00:00 0',
        'Rss:                    10 kB'
      ].join('\n')
    );
    expect(top[0]).toEqual({ name: '[heap]', rss_kb: 200 });
    expect(top[1]).toEqual({ name: '/usr/lib/libssl.so.3', rss_kb: 150 });
    expect(top[2]).toEqual({ name: 'anon', rss_kb: 10 });
  });
});
