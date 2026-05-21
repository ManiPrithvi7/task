import { createHash } from 'crypto';
import { getRedisService } from '../../services/redisService';
import { logger } from '../../utils/logger';

const DEDUPE_TTL_SEC = 86400;
const KEY_PREFIX = 'webhook:dedupe:';

export function buildShopifyDedupeKey(
  shop: string,
  topic: string,
  rawBody: string
): string {
  let orderId: string | null = null;
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const id =
      typeof parsed.checkout_id === 'number'
        ? String(parsed.checkout_id)
        : typeof parsed.checkout_id === 'string'
          ? parsed.checkout_id
          : typeof parsed.id === 'number'
            ? String(parsed.id)
            : typeof parsed.id === 'string'
              ? parsed.id
              : null;
    orderId = id;
  } catch {
    /* fall through to hash */
  }
  const dedupePart = orderId?.trim() || createHash('sha256').update(rawBody).digest('hex');
  return `shopify:${shop}:${topic}:${dedupePart}`;
}

export function buildSquareDedupeKey(
  merchantId: string,
  eventType: string,
  eventId: string | null,
  rawBody: string
): string {
  const dedupePart = eventId?.trim() || createHash('sha256').update(rawBody).digest('hex');
  return `square:${merchantId}:${eventType}:${dedupePart}`;
}

/**
 * Returns true if this is a new event (should process). False if duplicate.
 */
export async function tryClaimWebhookDedupe(dedupeKey: string): Promise<boolean> {
  const redis = getRedisService();
  if (!redis?.isRedisConnected()) {
    logger.warn('[WEBHOOK_DEDUPE] Redis unavailable — processing without dedupe', { dedupeKey });
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
      error: err instanceof Error ? err.message : String(err)
    });
    return true;
  }
}
