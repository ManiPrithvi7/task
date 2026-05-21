import { getRedisService } from '../redisService';
import { logger } from '../../utils/logger';
import { DAILY_METRICS_LUA } from './dailyMetricsLua';
import {
  getDailyMetricsKeys,
  getDateBucket,
  priceToCents,
  resolveMetricsTimezone
} from './helpers';

export interface DailyMetricsInput {
  userId: string;
  checkoutId: string;
  totalPrice: string;
  paidAt: string;
  hasDiscount: boolean;
}

let cachedScriptSha: string | null = null;

async function getScriptSha(): Promise<string | null> {
  if (cachedScriptSha) return cachedScriptSha;
  const redis = getRedisService();
  if (!redis?.isRedisConnected()) return null;
  try {
    cachedScriptSha = await redis.getClient().scriptLoad(DAILY_METRICS_LUA);
    return cachedScriptSha;
  } catch (err) {
    logger.warn('[DAILY_METRICS] scriptLoad failed', {
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

export async function processDailyMetrics(input: DailyMetricsInput): Promise<void> {
  const redis = getRedisService();
  if (!redis?.isRedisConnected()) {
    logger.warn('[DAILY_METRICS] Redis unavailable — skip');
    return;
  }

  const checkoutId = input.checkoutId.trim();
  if (!checkoutId) return;

  try {
    const timezone = resolveMetricsTimezone();
    const { dateKey, ttlSeconds } = getDateBucket(input.paidAt, timezone);
    const revenueCents = priceToCents(input.totalPrice);
    const keys = getDailyMetricsKeys(input.userId, dateKey);
    const lastOrderJson = JSON.stringify({
      checkoutId,
      revenueCents,
      paidAt: input.paidAt,
      hasDiscount: input.hasDiscount
    });

    const sha = await getScriptSha();
    const client = redis.getClient();

    if (sha) {
      await client.evalSha(sha, {
        keys: [keys.setKey, keys.countKey, keys.revenueCentsKey, keys.lastKey],
        arguments: [checkoutId, String(revenueCents), String(ttlSeconds), lastOrderJson]
      });
    } else {
      await client.eval(DAILY_METRICS_LUA, {
        keys: [keys.setKey, keys.countKey, keys.revenueCentsKey, keys.lastKey],
        arguments: [checkoutId, String(revenueCents), String(ttlSeconds), lastOrderJson]
      });
    }

    logger.debug('[DAILY_METRICS] Recorded', { userId: input.userId, dateKey, checkoutId });
  } catch (err) {
    logger.error('[DAILY_METRICS] Failed', {
      userId: input.userId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
