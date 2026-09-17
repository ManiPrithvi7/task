interface CacheEntry<T> {
  data: T;
  createdAt: number;
}

/** Hard ceiling — dashboard payloads are 90-day Influx rows; never hold more than this many. */
export const MAX_CACHE_ENTRIES = 100;
/** Abandoned entries (no longer within SWR windows) are dropped on the next access. */
export const MAX_CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, CacheEntry<unknown>>();

const DEFAULT_FRESH_MS = 30_000;
const DEFAULT_STALE_MS = 120_000;

function sweepStale(maxAgeMs: number = MAX_CACHE_TTL_MS): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.createdAt > maxAgeMs) {
      cache.delete(key);
    }
  }
}

function put(key: string, data: unknown, createdAt: number = Date.now()): void {
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { data, createdAt });
}

function touch(key: string, entry: CacheEntry<unknown>): void {
  cache.delete(key);
  cache.set(key, entry);
}

export function cachedQuery<T>(
  key: string,
  queryFn: () => Promise<T>,
  options?: { freshMs?: number; staleMs?: number }
): Promise<T> {
  sweepStale();

  const freshMs = options?.freshMs ?? DEFAULT_FRESH_MS;
  const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
  const entry = cache.get(key);
  const now = Date.now();

  if (entry && now - entry.createdAt < freshMs) {
    touch(key, entry);
    return Promise.resolve(entry.data as T);
  }

  if (entry && now - entry.createdAt < staleMs) {
    touch(key, entry);
    queryFn()
      .then((data) => {
        put(key, data);
      })
      .catch(() => {});
    return Promise.resolve(entry.data as T);
  }

  return queryFn().then((data) => {
    put(key, data);
    return data;
  });
}

export function invalidateCache(prefix: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

export function invalidateDeviceCache(deviceId: string): void {
  if (!deviceId) return;
  for (const key of cache.keys()) {
    if (key.includes(deviceId)) cache.delete(key);
  }
}

export function clearInfluxQueryCache(): void {
  cache.clear();
}

export function influxQueryCacheSize(): number {
  return cache.size;
}
