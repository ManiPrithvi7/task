import { getInfluxService } from '../influxService';
import { getRedisService } from '../redisService';
import { logger } from '../../utils/logger';
import {
  getDateBucket,
  getPosDailyCacheKeys,
  getPosDailyCacheTtlSec,
  resolveMetricsTimezone
} from '../metrics/helpers';

/** Sentinel device_id for user-scoped order ledger (one point per order). */
export const POS_INFLUX_DEVICE_SENTINEL = '_user';

export type IngestPosOrderInput = {
  userId: string;
  platform: 'shopify' | 'square';
  orderId: string;
  paidAt: string;
  topSellerLine?: string;
  totalAmount?: number;
  currency?: string;
  itemCount?: number;
};

export async function ingestPosOrder(input: IngestPosOrderInput): Promise<void> {
  const influx = getInfluxService();
  if (!influx) {
    logger.error('[POS_INGEST] Influx unavailable — cannot record order', {
      userId: input.userId,
      orderId: input.orderId
    });
    return;
  }

  const timestamp = new Date(input.paidAt);
  const ts = Number.isNaN(timestamp.getTime()) ? new Date() : timestamp;

  await influx.writeWebhookOrder(
    {
      platform: input.platform,
      deviceId: POS_INFLUX_DEVICE_SENTINEL,
      userId: input.userId,
      orderId: input.orderId,
      totalAmount: input.totalAmount,
      currency: input.currency,
      itemCount: input.itemCount,
      topSellerLine: input.topSellerLine,
      timestamp: ts
    },
    { flush: true }
  );

  const redis = getRedisService();
  if (!redis?.isRedisConnected()) return;

  try {
    const timezone = resolveMetricsTimezone();
    const { dateKey } = getDateBucket(ts.toISOString(), timezone);
    const keys = getPosDailyCacheKeys(input.userId, dateKey);
    const client = redis.getClient();
    const ttl = getPosDailyCacheTtlSec();

    if (input.topSellerLine?.trim()) {
      await client.set(keys.topSellerKey, input.topSellerLine.trim().slice(0, 256), { EX: ttl });
    }
  } catch (err: unknown) {
    logger.debug('[POS_INGEST] Redis cache refresh failed (Influx is authoritative)', {
      userId: input.userId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
