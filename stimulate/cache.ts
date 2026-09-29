/**
 * TEMP STIMULATE — in-memory ramp cursor with TTL.
 * Durable follower/review counts live in stimDeviceCache (stim Redis/local),
 * never in the production device hash.
 */

export const STIM_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface StimCacheEntry {
  lastPublished: number;
  status: 'running' | 'done';
  expiresAt: number;
}

// process-local Map; stimDeviceCache is the restart source of truth for counts
const store = new Map<string, StimCacheEntry>();

function key(platform: string, deviceId: string): string {
  return `${platform}:${deviceId}`;
}

/** Prefer in-memory cursor; else last stim-cache count; else emptyDefault. */
export function resolveLastPublished(
  platform: string,
  deviceId: string,
  emptyDefault: number,
  stimCachedValue?: number
): number {
  const cached = readStimCache(platform, deviceId);
  if (cached) return cached.lastPublished;
  if (stimCachedValue != null && stimCachedValue > 0) return stimCachedValue;
  return emptyDefault;
}

export function readStimCache(platform: string, deviceId: string): StimCacheEntry | null {
  const entry = store.get(key(platform, deviceId));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key(platform, deviceId));
    return null;
  }
  return entry;
}

export function writeStimCache(
  platform: string,
  deviceId: string,
  entry: Omit<StimCacheEntry, 'expiresAt'>,
): void {
  store.set(key(platform, deviceId), {
    lastPublished: entry.lastPublished,
    status: entry.status,
    expiresAt: Date.now() + STIM_CACHE_TTL_MS,
  });
}

export function clearStimCache(platform: string, deviceId: string): void {
  store.delete(key(platform, deviceId));
}

export function clearAllStimCache(): void {
  store.clear();
}

export function stimCacheSize(): number {
  return store.size;
}

export function clearDeviceStimCache(deviceId: string): void {
  for (const k of [...store.keys()]) {
    if (k.endsWith(`:${deviceId}`)) store.delete(k);
  }
}
