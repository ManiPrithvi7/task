import { getRedisService } from '../../services/redisService';
import { logger } from '../../utils/logger';

const DEDUPE_TTL_SEC = 86400;
const KEY_PREFIX = 'webhook:dedupe:';

/**
 * Returns true if this is a new event (should process). False if duplicate.
 */
export async function tryClaimWebhookDedupe(dedupeKey: string): Promise<boolean> {
  const redis = getRedisService();
  if (!redis?.isRedisConnected()) {
    // Pilot: fail-open (process without dedupe). Alert on rising dedupe_fail_open logs.
    logger.warn('[WEBHOOK_DEDUPE] Redis unavailable — processing without dedupe', {
      dedupeKey,
      dedupe_fail_open: true
    });
    return true;
  }

  try {
    const client = redis.getClient();
    const fullKey = `${KEY_PREFIX}${dedupeKey}`;
    const result = await client.set(fullKey, '1', { NX: true, EX: DEDUPE_TTL_SEC });
    return result === 'OK';
  } catch (err: unknown) {
    logger.warn('[WEBHOOK_DEDUPE] Redis error — allowing processing', {
      dedupeKey,
      dedupe_fail_open: true,
      error: err instanceof Error ? err.message : String(err)
    });
    return true;
  }
}
