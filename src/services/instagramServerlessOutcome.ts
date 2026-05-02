/**
 * Turn normalized serverless fetch rows into Influx audit/metrics, correlation hooks, MQTT screen updates.
 */

import { logger } from '../utils/logger';
import { InstagramCircuitBreaker } from './instagramCircuitBreaker';
import {
  abandonAttentionCorrelation,
  observeAttentionFetchLatencyMs
} from './instagramPollingMetrics';
import { REDIS_KEYS } from './instagramPollingLua';
import { getInfluxService } from './influxService';
import { getRedisService } from './redisService';
import type { MqttClientManager } from '../servers/mqttClient';
import { publishInstagramScreenIfChanged, type ScreenDeliveryFetchShape } from './instagramScreenDelivery';

export type NormalizedDeviceFetchResult = {
  deviceId: string;
  success: boolean;
  fetched_at: string;
  followers_count?: number;
  error?: string;
  instagram_account_id?: string;
  api_response_time_ms?: number;
  cache_hit?: boolean;
  http_status?: number;
  retry_after_seconds?: number;
  error_code?: string | number;
};

async function readCachedFollowers(deviceId: string): Promise<number | null> {
  const redisSvc = getRedisService();
  if (!redisSvc?.isRedisConnected()) return null;
  try {
    const raw = await redisSvc.getClient().get(REDIS_KEYS.deviceFollowers(deviceId));
    if (raw === null) return null;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

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
  const oldFollowers = await readCachedFollowers(deviceId);
  const newFollowers = row.success && row.followers_count != null ? row.followers_count : null;

  await maybeOpenCircuitFromOutcome(row);

  const cid = correlationId;

  if (!row.success) {
    abandonAttentionCorrelation(cid);
  }

  let e2eMs: number | undefined;
  if (cid && row.success) {
    e2eMs = observeAttentionFetchLatencyMs(cid);
  }

  const apiMs = row.api_response_time_ms ?? 0;
  const igAccount = row.instagram_account_id ?? '';
  const auditTs = new Date(row.fetched_at);

  const influx = getInfluxService();
  if (influx) {
    try {
      await influx.writeInstagramFetchAudit(
        {
          deviceId,
          success: row.success,
          triggerType: trigger,
          correlationId: cid,
          instagramAccountId: igAccount || undefined,
          oldFollowers,
          newFollowers,
          durationMs: apiMs,
          errorMessage: row.success ? undefined : (row.error || 'unknown'),
          errorCode: row.success ? undefined : row.error_code,
          timestamp: auditTs
        },
        { flush: false }
      );

      if (row.success && row.followers_count != null) {
        await influx.writeInstagramFollowersGauge(deviceId, igAccount, row.followers_count, auditTs, {
          flush: false
        });
      }

      if (e2eMs !== undefined && cid) {
        await influx.writeInstagramAttentionE2eLatency(deviceId, trigger, e2eMs, auditTs, { flush: false });
      }

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
      ? { data: { followers_count: row.followers_count } }
      : { error: row.error }),
    ...(cid ? { correlation_id: cid } : {})
  };

  await publishInstagramScreenIfChanged(mqttClient, topicRoot, screenShape);
}
