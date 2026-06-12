/**
 * Redis-backed rate limit for OTA check/report endpoints.
 */

import type { RedisClientType } from 'redis';
import { logger } from '../utils/logger';

export async function checkOtaRateLimit(
  client: RedisClientType | null,
  keyPrefix: string,
  deviceId: string,
  windowSec: number
): Promise<boolean> {
  if (!client || windowSec <= 0) {
    return true;
  }

  const key = `${keyPrefix}ota:check:${deviceId}`;
  try {
    const set = await client.set(key, '1', { NX: true, EX: windowSec });
    return set === 'OK';
  } catch (err: unknown) {
    logger.warn('[OTA] Rate limit check failed — allowing request', {
      deviceId,
      error: err instanceof Error ? err.message : String(err)
    });
    return true;
  }
}
