/**
 * In-process Instagram Graph fetches when no serverless worker URL is configured.
 * Credentials: Redis `proof.mqtt:device:{deviceId}` first, else same fields on the local active-device row
 * (both written at `/active` registration from Mongo: Device.userId → Social INSTAGRAM).
 */

import { logger } from '../utils/logger';
import type { InstagramFetchInvoker } from './instagramServerlessBridge';
import type { MqttClientManager } from '../servers/mqttClient';
import { fetchInstagramMetrics, type InstagramFetchResult } from './instagramApiClient';
import {
  applyInstagramServerlessDeviceOutcome,
  type NormalizedDeviceFetchResult
} from './instagramServerlessOutcome';
import { getRedisService } from './redisService';
import { getActiveDeviceCache } from './deviceService';

const DEVICE_META_KEY_PREFIX = 'proof.mqtt:device:';

interface ResolvedMeta {
  instagramAccountId: string;
  accessToken: string;
  userId?: string;
}

function toNormalizedRow(deviceId: string, result: InstagramFetchResult): NormalizedDeviceFetchResult {
  const fetched_at = new Date().toISOString();
  const row: NormalizedDeviceFetchResult = {
    deviceId,
    success: result.success,
    fetched_at,
    instagram_account_id: result.instagramAccountId,
    api_response_time_ms: result.apiResponseTimeMs,
    cache_hit: result.cacheHit
  };
  if (result.success && result.metrics) {
    row.followers_count = result.metrics.followers_count;
  }
  if (!result.success && result.error) {
    row.error = result.error;
  }
  if (result.httpStatus !== undefined) {
    row.http_status = result.httpStatus;
  }
  if (result.retryAfterSeconds !== undefined) {
    row.retry_after_seconds = result.retryAfterSeconds;
  }
  if (result.errorCode !== undefined) {
    row.error_code = result.errorCode;
  }
  return row;
}

async function loadMetaFromRedis(deviceId: string): Promise<ResolvedMeta | null> {
  const redisSvc = getRedisService();
  if (!redisSvc?.isRedisConnected()) return null;
  try {
    const raw = await redisSvc.getClient().get(`${DEVICE_META_KEY_PREFIX}${deviceId}`);
    if (!raw) return null;
    const o = JSON.parse(raw) as Record<string, unknown>;
    const instagramAccountId = typeof o.instagramAccountId === 'string' ? o.instagramAccountId.trim() : '';
    const accessToken = typeof o.accessToken === 'string' ? o.accessToken.trim() : '';
    if (!instagramAccountId || !accessToken) return null;
    return { instagramAccountId, accessToken };
  } catch {
    return null;
  }
}

async function loadMetaFromLocalCache(deviceId: string): Promise<ResolvedMeta | null> {
  const ad = await getActiveDeviceCache().getActive(deviceId);
  if (!ad) return null;
  const instagramAccountId = ad.instagramAccountId?.trim() || '';
  const accessToken = ad.accessToken?.trim() || '';
  if (!instagramAccountId || !accessToken) return null;
  return { instagramAccountId, accessToken, userId: ad.userId };
}

export class InstagramDirectFetchInvoker implements InstagramFetchInvoker {
  constructor(private readonly mqttClient: MqttClientManager) {}

  isConfigured(): boolean {
    return true;
  }

  async invokeFetch(
    deviceIds: string[],
    opts: { trigger: 'attention' | 'scheduled'; correlationId?: string }
  ): Promise<boolean> {
    const topicRoot = this.mqttClient.getTopicRoot();
    let successes = 0;
    const cid =
      opts.correlationId && deviceIds.length === 1 && opts.trigger === 'attention'
        ? opts.correlationId
        : undefined;

    for (const deviceId of deviceIds) {
      const fromRedis = await loadMetaFromRedis(deviceId);
      const meta = fromRedis ?? (await loadMetaFromLocalCache(deviceId));

      if (!meta) {
        const level = opts.trigger === 'attention' ? 'info' : 'debug';
        logger[level]('[IG_DIRECT] No Instagram credentials (Redis proof.mqtt:device:{id} or active-devices.json)', {
          deviceId,
          trigger: opts.trigger
        });
        if (opts.trigger === 'attention' && deviceIds.length === 1) {
          await applyInstagramServerlessDeviceOutcome(
            {
              deviceId,
              success: false,
              fetched_at: new Date().toISOString(),
              error: 'no_instagram_credentials'
            },
            this.mqttClient,
            topicRoot,
            opts.trigger,
            cid
          );
        }
        continue;
      }

      const result = await fetchInstagramMetrics(deviceId, {
        accessToken: meta.accessToken,
        instagramAccountId: meta.instagramAccountId,
        userId: meta.userId || ''
      });

      const row = toNormalizedRow(deviceId, result);
      await applyInstagramServerlessDeviceOutcome(row, this.mqttClient, topicRoot, opts.trigger, cid);
      if (result.success) successes++;
    }

    return successes > 0;
  }
}
