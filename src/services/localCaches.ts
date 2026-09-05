/** Local-first utility caches — Redis only as recovery / durable mirror. */

export class LocalTtlCache<T> {
  private cache = new Map<string, { data: T; expiresAt: number }>();

  get(key: string): T | null {
    const e = this.cache.get(key);
    if (!e) return null;
    if (Date.now() > e.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return e.data;
  }

  set(key: string, data: T, ttlMs: number): void {
    this.cache.set(key, { data, expiresAt: Date.now() + Math.max(0, ttlMs) });
  }

  del(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }
}

export class LocalPromoRotationCache {
  private rotation = new Map<string, number>();

  get(deviceId: string): number {
    return this.rotation.get(deviceId) ?? 0;
  }

  increment(deviceId: string): number {
    const next = this.get(deviceId) + 1;
    this.rotation.set(deviceId, next);
    return next;
  }

  clear(deviceId: string): void {
    this.rotation.delete(deviceId);
  }

  size(): number {
    return this.rotation.size;
  }
}

export class LocalPublishHashCache {
  private cache = new Map<string, { hash: string; expiresAt: number }>();

  private key(deviceId: string, topic: string): string {
    return `${deviceId}:${topic}`;
  }

  get(deviceId: string, topic: string): string | null {
    const k = this.key(deviceId, topic);
    const e = this.cache.get(k);
    if (!e) return null;
    if (Date.now() > e.expiresAt) {
      this.cache.delete(k);
      return null;
    }
    return e.hash;
  }

  set(deviceId: string, topic: string, hash: string, ttlMs: number): void {
    this.cache.set(this.key(deviceId, topic), {
      hash,
      expiresAt: Date.now() + Math.max(0, ttlMs)
    });
  }

  del(deviceId: string, topic: string): boolean {
    return this.cache.delete(this.key(deviceId, topic));
  }

  clear(deviceId: string): number {
    const prefix = `${deviceId}:`;
    let removed = 0;
    for (const k of this.cache.keys()) {
      if (k.startsWith(prefix)) {
        this.cache.delete(k);
        removed++;
      }
    }
    return removed;
  }

  size(): number {
    return this.cache.size;
  }
}

export class LocalStimLock {
  private locks = new Map<string, { acquiredAt: number; ttlMs: number }>();

  private key(deviceId: string, type: 'ig' | 'gmb'): string {
    return `${type}:${deviceId}`;
  }

  private isAlive(e: { acquiredAt: number; ttlMs: number }): boolean {
    return Date.now() - e.acquiredAt < e.ttlMs;
  }

  tryAcquire(deviceId: string, type: 'ig' | 'gmb', ttlMs: number): boolean {
    const k = this.key(deviceId, type);
    const existing = this.locks.get(k);
    if (existing && this.isAlive(existing)) return false;
    this.locks.set(k, { acquiredAt: Date.now(), ttlMs });
    return true;
  }

  refresh(deviceId: string, type: 'ig' | 'gmb', ttlMs: number): void {
    const k = this.key(deviceId, type);
    if (!this.locks.has(k)) return;
    this.locks.set(k, { acquiredAt: Date.now(), ttlMs });
  }

  release(deviceId: string, type: 'ig' | 'gmb'): void {
    this.locks.delete(this.key(deviceId, type));
  }

  releaseAll(deviceId: string): void {
    this.locks.delete(this.key(deviceId, 'ig'));
    this.locks.delete(this.key(deviceId, 'gmb'));
  }

  isLocked(deviceId: string, type: 'ig' | 'gmb'): boolean {
    const e = this.locks.get(this.key(deviceId, type));
    if (!e) return false;
    if (!this.isAlive(e)) {
      this.locks.delete(this.key(deviceId, type));
      return false;
    }
    return true;
  }
}

export class LocalConnectDebounce {
  private lastRefresh = new Map<string, number>();

  shouldRefresh(deviceId: string, debounceMs: number): boolean {
    const now = Date.now();
    const prev = this.lastRefresh.get(deviceId) ?? 0;
    if (now - prev < debounceMs) return false;
    this.lastRefresh.set(deviceId, now);
    return true;
  }

  clear(deviceId: string): void {
    this.lastRefresh.delete(deviceId);
  }
}

export interface ProvTokenEntry {
  deviceId: string;
  userId: string;
  consumed: boolean;
  consumedAt: number;
  createdAt: number;
  expiresAt: number;
}

export class LocalProvCache {
  tokens = new Map<string, ProvTokenEntry>();
  deviceIndex = new Map<string, string>(); // deviceId → token
  dirtyTokens = new Set<string>();

  clear(): void {
    this.tokens.clear();
    this.deviceIndex.clear();
    this.dirtyTokens.clear();
  }
}

let stimLockInstance: LocalStimLock | null = null;
let promoRotationInstance: LocalPromoRotationCache | null = null;
let publishHashInstance: LocalPublishHashCache | null = null;
let connectDebounceInstance: LocalConnectDebounce | null = null;
let provCacheInstance: LocalProvCache | null = null;
let promoActiveCache: LocalTtlCache<unknown> | null = null;
let canvasActiveCache: LocalTtlCache<unknown> | null = null;
let integrationsCache: LocalTtlCache<unknown> | null = null;

export function getLocalStimLock(): LocalStimLock {
  if (!stimLockInstance) stimLockInstance = new LocalStimLock();
  return stimLockInstance;
}

export function getLocalPromoRotationCache(): LocalPromoRotationCache {
  if (!promoRotationInstance) promoRotationInstance = new LocalPromoRotationCache();
  return promoRotationInstance;
}

export function getLocalPublishHashCache(): LocalPublishHashCache {
  if (!publishHashInstance) publishHashInstance = new LocalPublishHashCache();
  return publishHashInstance;
}

export function getLocalConnectDebounce(): LocalConnectDebounce {
  if (!connectDebounceInstance) connectDebounceInstance = new LocalConnectDebounce();
  return connectDebounceInstance;
}

export function getLocalProvCache(): LocalProvCache {
  if (!provCacheInstance) provCacheInstance = new LocalProvCache();
  return provCacheInstance;
}

export function getLocalPromoActiveCache<T = unknown>(): LocalTtlCache<T> {
  if (!promoActiveCache) promoActiveCache = new LocalTtlCache();
  return promoActiveCache as LocalTtlCache<T>;
}

export function getLocalCanvasActiveCache<T = unknown>(): LocalTtlCache<T> {
  if (!canvasActiveCache) canvasActiveCache = new LocalTtlCache();
  return canvasActiveCache as LocalTtlCache<T>;
}

export function getLocalIntegrationsCache<T = unknown>(): LocalTtlCache<T> {
  if (!integrationsCache) integrationsCache = new LocalTtlCache();
  return integrationsCache as LocalTtlCache<T>;
}

export function resetLocalCachesForTests(): void {
  stimLockInstance = null;
  promoRotationInstance = null;
  publishHashInstance = null;
  connectDebounceInstance = null;
  provCacheInstance = null;
  promoActiveCache = null;
  canvasActiveCache = null;
  integrationsCache = null;
}
