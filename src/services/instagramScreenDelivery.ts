/**
 * Build MQTT screen payloads and publish when follower count changed.
 * Offline pending queue intentionally omitted (architecture uses direct serverless → MQTT).
 */

import { logger } from '../utils/logger';
import { getRedisService } from './redisService';
import { getActiveDeviceCache } from './deviceService';
import type { MqttClientManager } from '../servers/mqttClient';
import { buildScreenEnvelope, instagramFollowerMetrics } from './screenEnvelope';

export type ScreenDeliveryFetchShape = {
  deviceId: string;
  success: boolean;
  fetched_at: string;
  data?: { followers_count: number; instagram_username?: string };
  error?: string;
  correlation_id?: string;
};

/**
 * PROOF Display v6 Instagram: `nextGoal` (+25 milestones), `celebration` on envelope, no `celebration_type` when not celebrating.
 * Inner metrics from Instagram Graph (or serverless); envelope matches `StatsPublisher` mock Instagram.
 */
export function formatInstagramScreenMqttPayload(
  result: ScreenDeliveryFetchShape,
  topicRoot: string
): { topic: string; payload: string } {
  const { deviceId, data } = result;
  const followers = data?.followers_count ?? 0;
  const { nextGoal, remainingGoal, progress } = instagramFollowerMetrics(followers);
  const handle = data?.instagram_username?.trim().replace(/^@/, '') || '';
  const qrText = handle ? `https://instagram.com/${handle}` : 'https://www.instagram.com/';

  let fetchedAtMs = Date.parse(result.fetched_at);
  if (!Number.isFinite(fetchedAtMs)) {
    fetchedAtMs = Date.now();
  }

  const base = buildScreenEnvelope(
    'instagram',
    {
      followers,
      nextGoal,
      remainingGoal,
      progress,
      qrText
    },
    {
      muted: 'true',
      timestamp: new Date(fetchedAtMs)
    }
  );

  const envelope: Record<string, unknown> = { ...base };
  if (result.correlation_id) {
    envelope.correlation_id = result.correlation_id;
  }

  return {
    topic: `${topicRoot}/${deviceId}/instagram`,
    payload: JSON.stringify(envelope)
  };
}

/**
 * Updates Redis follower cache if changed; publishes MQTT when device is active.
 */
export async function publishInstagramScreenIfChanged(
  mqttClient: MqttClientManager,
  topicRoot: string,
  result: ScreenDeliveryFetchShape
): Promise<void> {
  const { deviceId, success } = result;
  if (!success || !result.data) {
    logger.warn('[IG_SCREEN] Skipping MQTT for failed fetch', { deviceId, error: result.error });
    return;
  }

  const redisSvc = getRedisService();
  if (redisSvc?.isRedisConnected()) {
    try {
      const client = redisSvc.getClient();
      const cacheKey = `device:followers:${deviceId}`;
      const cachedRaw = await client.get(cacheKey);
      const cached = cachedRaw !== null ? parseInt(cachedRaw, 10) : null;
      const next = result.data.followers_count;

      if (typeof cached === 'number' && !Number.isNaN(cached) && cached === next) {
        logger.debug('[IG_SCREEN] No follower change, skip MQTT', { deviceId, followers: next });
        return;
      }

      await client.set(cacheKey, String(next), { EX: 86400 });
    } catch (err: unknown) {
      logger.warn('[IG_SCREEN] Change detection failed (continuing)', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const cache = getActiveDeviceCache();
  const activeDevices = await cache.getAllActive();
  const isActive = activeDevices.some((d) => d.deviceId === deviceId);

  const { topic, payload } = formatInstagramScreenMqttPayload(result, topicRoot);

  if (isActive) {
    try {
      await mqttClient.publish({ topic, payload, qos: 1, retain: false });
      logger.info('[IG_SCREEN] Published to device', { deviceId, topic, followers: result.data.followers_count });
    } catch (err: unknown) {
      logger.error('[IG_SCREEN] MQTT publish failed', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  } else {
    logger.info('[IG_SCREEN] Device offline — screen update skipped (no pending queue)', { deviceId });
  }
}
