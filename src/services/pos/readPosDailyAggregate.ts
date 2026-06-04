import { getInfluxService } from '../influxService';
import { getRedisService } from '../redisService';
import { logger } from '../../utils/logger';
import {
  getDateKeyForInstant,
  getPosDailyCacheKeys,
  getPosDailyCacheTtlSec,
  getStartOfDayInTimezone,
  resolveMetricsTimezone
} from '../metrics/helpers';

export type PosDailyAggregate = {
  orderCountToday: number;
  topSellerLine?: string;
};

export async function readPosDailyAggregate(
  userId: string,
  at: Date = new Date(),
  opts?: { platform?: 'shopify' | 'square' }
): Promise<PosDailyAggregate> {
  const timezone = resolveMetricsTimezone();
  const dateKey = getDateKeyForInstant(at, timezone);
  const cacheKeys = getPosDailyCacheKeys(userId, dateKey);
  const redis = getRedisService();

  let cachedCount: number | null = null;
  let cachedTopSeller: string | undefined;

  if (redis?.isRedisConnected()) {
    try {
      const client = redis.getClient();
      const [countRaw, topRaw] = await Promise.all([
        client.get(cacheKeys.countKey),
        client.get(cacheKeys.topSellerKey)
      ]);
      if (countRaw !== null && countRaw !== '') {
        const n = Number(countRaw);
        if (Number.isFinite(n)) cachedCount = Math.max(0, Math.floor(n));
      }
      if (topRaw?.trim()) cachedTopSeller = topRaw.trim();
    } catch (err: unknown) {
      logger.debug('[POS_AGGREGATE] Redis cache read failed', {
        userId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  if (cachedCount !== null) {
    return { orderCountToday: cachedCount, topSellerLine: cachedTopSeller };
  }

  const influx = getInfluxService();
  if (!influx) {
    logger.warn('[POS_AGGREGATE] Influx unavailable — returning 0', { userId });
    return { orderCountToday: 0, topSellerLine: cachedTopSeller };
  }

  try {
    const startOfDay = getStartOfDayInTimezone(at, timezone);
    const orderCountToday = await influx.queryPosDailyOrderCount(userId, startOfDay, opts?.platform);

    if (redis?.isRedisConnected()) {
      try {
        const client = redis.getClient();
        const ttl = getPosDailyCacheTtlSec();
        await client.set(cacheKeys.countKey, String(orderCountToday), { EX: ttl });
        if (cachedTopSeller) {
          await client.set(cacheKeys.topSellerKey, cachedTopSeller, { EX: ttl });
        }
      } catch {
        /* cache backfill best-effort */
      }
    }

    return { orderCountToday, topSellerLine: cachedTopSeller };
  } catch (err: unknown) {
    logger.error('[POS_AGGREGATE] Influx query failed', {
      userId,
      error: err instanceof Error ? err.message : String(err)
    });
    if (cachedCount !== null) {
      return { orderCountToday: cachedCount, topSellerLine: cachedTopSeller };
    }
    return { orderCountToday: 0, topSellerLine: cachedTopSeller };
  }
}
