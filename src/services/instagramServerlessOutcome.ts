/**
 * Turn normalized serverless fetch rows into Influx audit/metrics, correlation hooks, MQTT screen updates.
 */

import { logger } from '../utils/logger';
import { InstagramCircuitBreaker } from './instagramCircuitBreaker';
import { getInfluxService } from './influxService';
import { getRedisService } from './redisService';
import type { MqttClientManager } from '../servers/mqttClient';
import { publishInstagramScreenIfChanged, type ScreenDeliveryFetchShape } from './instagramScreenDelivery';

export type NormalizedDeviceFetchResult = {
  deviceId: string;
  success: boolean;
  fetched_at: string;
  followers_count?: number;
  /** IG @handle from Graph or serverless worker (optional). */
  instagram_username?: string;
  error?: string;
  instagram_account_id?: string;
  api_response_time_ms?: number;
  cache_hit?: boolean;
  http_status?: number;
  retry_after_seconds?: number;
  error_code?: string | number;
};

async function maybeOpenCircuitFromOutcome(row: NormalizedDeviceFetchResult): Promise<void> {
  try {
    const redisSvc = getRedisService();
    if (!redisSvc?.isRedisConnected()) return;
    const breaker = new InstagramCircuitBreaker(redisSvc.getClient());

    if (!row.success && row.http_status === 429 && row.retry_after_seconds != null) {
      const secs = Math.max(1, Math.floor(row.retry_after_seconds));
      await breaker.open(secs);
      logger.warn('[IG_SERVERLESS] Circuit opened (429 Retry-After)', { deviceId: row.deviceId, secs });
      return;
    }

    const rateLimitCodes = new Set<string>(['4', '17', '32', 'RATE_LIMIT_GLOBAL', 'RATE_LIMIT_DEVICE', 'RATE_LIMIT_BURST']);
    const code = row.error_code !== undefined ? String(row.error_code) : null;
    if (!row.success && code && rateLimitCodes.has(code)) {
      await breaker.open(60);
      logger.warn('[IG_SERVERLESS] Circuit opened (API throttle code)', { deviceId: row.deviceId, code });
    }
  } catch (err: unknown) {
    logger.debug('[IG_SERVERLESS] Circuit breaker hook failed (ignored)', {
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

/** Circuit + Influx (audit + metrics + optional E2E) + MQTT for one serverless row. */
export async function applyInstagramServerlessDeviceOutcome(
  row: NormalizedDeviceFetchResult,
  mqttClient: MqttClientManager,
  topicRoot: string,
  trigger: string,
  correlationId?: string
): Promise<void> {
  const deviceId = row.deviceId;

  await maybeOpenCircuitFromOutcome(row);

  const cid = correlationId;
  const igAccount = row.instagram_account_id ?? '';
  const auditTs = new Date(row.fetched_at);

  const influx = getInfluxService();
  if (influx) {
    try {
      // Persist one normalized row as milestone-ready metrics (no separate fetch audit series).
      await influx.writeInstagramMetrics({
        device_id: deviceId,
        instagram_account_id: igAccount || 'unknown',
        followers_count: row.followers_count ?? 0,
        fetch_timestamp: auditTs,
        success: row.success,
        error_message: row.success ? undefined : (row.error || 'unknown')
      });

      await influx.flushWrites();
    } catch (err: unknown) {
      logger.debug('[IG_SERVERLESS] Influx write failed (ignored)', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const screenShape: ScreenDeliveryFetchShape = {
    deviceId,
    success: row.success,
    fetched_at: row.fetched_at,
    ...(row.success && row.followers_count != null
      ? {
          data: {
            followers_count: row.followers_count,
            ...(row.instagram_username?.trim()
              ? { instagram_username: row.instagram_username.trim() }
              : {})
          }
        }
      : { error: row.error }),
    ...(cid ? { correlation_id: cid } : {})
  };

  await publishInstagramScreenIfChanged(mqttClient, topicRoot, screenShape);
}
