interface CacheEntry<T> {
  data: T;
  createdAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

const DEFAULT_FRESH_MS = 30_000;
const DEFAULT_STALE_MS = 120_000;

export function cachedQuery<T>(
  key: string,
  queryFn: () => Promise<T>,
  options?: { freshMs?: number; staleMs?: number }
): Promise<T> {
  const freshMs = options?.freshMs ?? DEFAULT_FRESH_MS;
  const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
  const entry = cache.get(key);
  const now = Date.now();

  if (entry && now - entry.createdAt < freshMs) {
    return Promise.resolve(entry.data as T);
  }

  if (entry && now - entry.createdAt < staleMs) {
    queryFn()
      .then((data) => {
        cache.set(key, { data, createdAt: Date.now() });
      })
      .catch(() => {});
    return Promise.resolve(entry.data as T);
  }

  return queryFn().then((data) => {
    cache.set(key, { data, createdAt: now });
    return data;
  });
}

export function invalidateCache(prefix: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

export function clearInfluxQueryCache(): void {
  cache.clear();
}

export function influxQueryCacheSize(): number {
  return cache.size;
}
