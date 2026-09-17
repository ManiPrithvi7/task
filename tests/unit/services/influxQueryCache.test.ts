import {
  cachedQuery,
  clearInfluxQueryCache,
  influxQueryCacheSize,
  invalidateCache,
  invalidateDeviceCache,
  MAX_CACHE_ENTRIES,
  MAX_CACHE_TTL_MS
} from '@/services/influxQueryCache';

describe('influxQueryCache caps', () => {
  afterEach(() => {
    clearInfluxQueryCache();
    jest.restoreAllMocks();
  });

  it('evicts the oldest entry once size hits MAX_CACHE_ENTRIES', async () => {
    for (let i = 0; i < MAX_CACHE_ENTRIES; i++) {
      await cachedQuery(`k-${i}`, async () => i);
    }
    expect(influxQueryCacheSize()).toBe(MAX_CACHE_ENTRIES);

    await cachedQuery('k-overflow', async () => 'x');
    expect(influxQueryCacheSize()).toBe(MAX_CACHE_ENTRIES);

    let fetches = 0;
    await cachedQuery('k-0', async () => {
      fetches += 1;
      return 'refetch';
    });
    expect(fetches).toBe(1);
  });

  it('sweeps entries older than MAX_CACHE_TTL_MS', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    await cachedQuery('stale-key', async () => 1);
    expect(influxQueryCacheSize()).toBe(1);

    now += MAX_CACHE_TTL_MS + 1;
    await cachedQuery('fresh-key', async () => 2);
    expect(influxQueryCacheSize()).toBe(1);

    let fetches = 0;
    await cachedQuery('stale-key', async () => {
      fetches += 1;
      return 3;
    });
    expect(fetches).toBe(1);
  });

  it('invalidateDeviceCache drops keys that contain the device id', async () => {
    await cachedQuery('ig:summary:dev-1:-90d', async () => ({ n: 1 }));
    await cachedQuery('ig:summary:dev-2:-90d', async () => ({ n: 2 }));
    invalidateDeviceCache('dev-1');
    expect(influxQueryCacheSize()).toBe(1);
  });

  it('invalidateCache still drops by prefix for write-path callers', async () => {
    await cachedQuery('gmb:summary:loc-1:-90d', async () => ({ n: 1 }));
    await cachedQuery('ig:summary:dev-1:-90d', async () => ({ n: 2 }));
    invalidateCache('gmb:summary:');
    expect(influxQueryCacheSize()).toBe(1);
  });
});
