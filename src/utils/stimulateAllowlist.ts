// TEMP STIMULATE — remove after testing
// Shared env parser so main app doesn't import stimulate/ server.

import { getRedisService } from '../services/redisService';

export function parseStimulateAllowlist(): string[] {
  const raw = process.env.STIMULATE_DEVICE?.trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isStimulateDevice(deviceId: string): boolean {
  const ids = parseStimulateAllowlist();
  return ids.length > 0 && ids.includes(deviceId);
}

/** Check Redis stim lock for a given platform. */
export async function hasStimLock(deviceId: string, platform: 'instagram' | 'gmb'): Promise<boolean> {
  const key = `stim:${platform === 'instagram' ? 'ig' : 'gmb'}:${deviceId}`;
  const redisSvc = getRedisService();
  if (!redisSvc?.isRedisConnected()) return false;
  try {
    const exists = await redisSvc.getClient().exists(key);
    return exists === 1;
  } catch {
    return false;
  }
}

/** Unified check: allowlisted AND locked for platform. Use in TEMP hooks. */
export async function shouldSkipForStimulate(deviceId: string, platform: 'instagram' | 'gmb'): Promise<boolean> {
  if (isStimulateDevice(deviceId)) return true;
  return hasStimLock(deviceId, platform);
}
