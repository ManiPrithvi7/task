import { getRedisService } from '../services/redisService';
import { logger } from '../utils/logger';

const KEY_PREFIX = 'gmb:reviews:';

/**
 * Last known verified review count per GMB location — milestone state cache (not webhook dedupe).
 * First event per location seeds baseline; cache miss skips milestone_crossed.
 */
export async function getGmbReviewCount(locationId: string): Promise<number | null> {
  const redis = getRedisService();
  if (!redis?.isRedisConnected()) return null;

  try {
    const raw = await redis.getClient().get(`${KEY_PREFIX}${locationId}`);
    if (raw === null || raw === undefined) return null;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
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
  if (!redis?.isRedisConnected()) return;

  try {
    await redis.getClient().set(`${KEY_PREFIX}${locationId}`, String(Math.max(0, Math.round(count))), { EX: 2592000 });
  } catch (err: unknown) {
    logger.warn('[GMB_REVIEW_CACHE] write failed', {
      locationId,
      error: err instanceof Error ? err.message : String(err)
    });
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
