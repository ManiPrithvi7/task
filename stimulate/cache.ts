/**
 * TEMP STIMULATE — in-memory progress only (no disk).
 * Server restart or device /active reset → ramp from scratch.
 */

export interface StimCacheEntry {
  lastPublished: number;
  status: 'running' | 'done';
}

// ponytail: process-local Map; ceiling = lost on restart (intentional — no data/stimulate files)
const store = new Map<string, StimCacheEntry>();

function key(platform: string, deviceId: string): string {
  return `${platform}:${deviceId}`;
}

export function readStimCache(platform: string, deviceId: string): StimCacheEntry | null {
  return store.get(key(platform, deviceId)) ?? null;
}

export function writeStimCache(platform: string, deviceId: string, entry: StimCacheEntry): void {
  store.set(key(platform, deviceId), entry);
}

export function clearStimCache(platform: string, deviceId: string): void {
  store.delete(key(platform, deviceId));
}

export function clearAllStimCache(): void {
  store.clear();
}

export function clearDeviceStimCache(deviceId: string): void {
  for (const k of [...store.keys()]) {
    if (k.endsWith(`:${deviceId}`)) store.delete(k);
  }
}
