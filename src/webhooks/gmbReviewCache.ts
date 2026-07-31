import { getRedisService } from '../services/redisService';
import {
  getIgDeviceRuntimeCache,
  syncScreenFieldImmediate
} from '../services/igDeviceRuntimeCache';
import { logger } from '../utils/logger';

const KEY_PREFIX = 'gmb:reviews:';
const TS_KEY_PREFIX = 'gmb:reviews:ts:';

export type GmbReviewCacheEntry = {
  count: number;
  updatedAtMs: number | null;
};

/**
 * Last known verified review count per GMB location — milestone state cache (not webhook dedupe).
 * First event per location seeds baseline; cache miss skips milestone write.
 */
export async function getGmbReviewCount(locationId: string): Promise<number | null> {
  const entry = await getGmbReviewCacheEntry(locationId);
  return entry?.count ?? null;
}

export async function getGmbReviewCacheEntry(locationId: string): Promise<GmbReviewCacheEntry | null> {
  const redis = getRedisService();
  if (!redis?.isRedisConnected()) return null;

  try {
    const client = redis.getClient();
    const [raw, tsRaw] = await Promise.all([
      client.get(`${KEY_PREFIX}${locationId}`),
      client.get(`${TS_KEY_PREFIX}${locationId}`)
    ]);
    if (raw === null || raw === undefined) return null;
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return null;
    const updatedAtMs = tsRaw != null ? parseInt(tsRaw, 10) : NaN;
    return {
      count: parsed,
      updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : null
    };
  } catch (err: unknown) {
    logger.warn('[GMB_REVIEW_CACHE] read failed', {
      locationId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

export async function setGmbReviewCount(locationId: string, count: number): Promise<void> {
  const redis = getRedisService();
  const normalized = Math.max(0, Math.round(count));
  const nowMs = Date.now();

  if (redis?.isRedisConnected()) {
    try {
      const client = redis.getClient();
      await Promise.all([
        client.set(`${KEY_PREFIX}${locationId}`, String(normalized), { EX: 2592000 }),
        client.set(`${TS_KEY_PREFIX}${locationId}`, String(nowMs), { EX: 2592000 })
      ]);
    } catch (err: unknown) {
      logger.warn('[GMB_REVIEW_CACHE] write failed', {
        locationId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const cache = getIgDeviceRuntimeCache();
  const devices = cache.getByGmbProfileId(locationId);
  for (const deviceId of devices) {
    cache.setGmbReviewCount(deviceId, normalized);
    cache.markDirty(deviceId, 'gmb_review_count');
    await syncScreenFieldImmediate(deviceId, 'gmb_review_count', normalized);
  }
}

/** Review milestones every 5 reviews up to 1000 (aligned with gmbReviewMetrics slabs). */
export function getGmbCrossedMilestones(oldCount: number, newCount: number): number[] {
  if (oldCount >= newCount) return [];
  const milestones: number[] = [];
  for (let m = 5; m <= 1000; m += 5) {
    if (oldCount < m && m <= newCount) milestones.push(m);
  }
  return milestones;
}
