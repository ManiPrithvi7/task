/**
 * Build MQTT screen payloads and publish when follower count changed.
 * Offline pending queue intentionally omitted (architecture uses direct serverless → MQTT).
 */

import { logger } from '../utils/logger';
import { getRedisService } from './redisService';
import { getActiveDeviceCache } from './deviceService';
import type { MqttClientManager } from '../servers/mqttClient';

export type ScreenDeliveryFetchShape = {
  deviceId: string;
  success: boolean;
  fetched_at: string;
  data?: { followers_count: number; instagram_username?: string };
  error?: string;
  correlation_id?: string;
};

function getNextMilestone(followers: number): number {
  const milestones = [100, 500, 1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];
  return milestones.find((m) => m > followers) ?? Math.ceil(followers / 1000) * 1000 + 1000;
}

/**
 * Same outer shape as `StatsPublisher` mock Instagram (`version` 1.2) so firmware stays compatible.
 * Inner metrics come from Instagram Graph (or serverless worker), not the screen publisher loop.
 */
export function formatInstagramScreenMqttPayload(
  result: ScreenDeliveryFetchShape,
  topicRoot: string
): { topic: string; payload: string } {
  const { deviceId, data } = result;
  const followers = data?.followers_count ?? 0;
  const achievement = getNextMilestone(followers);
  const progress = Math.min(100, Math.round((followers / achievement) * 100));
  const remainingGoal = Math.max(0, achievement - followers);
  const handle = data?.instagram_username?.trim().replace(/^@/, '') || '';
  const qrText = handle ? `https://instagram.com/${handle}` : 'https://www.instagram.com/';

  const envelope: Record<string, unknown> = {
    version: '1.2',
    screen: 'instagram',
    muted: 'true',
    timestamp: result.fetched_at,
    payload: {
      followers,
      achievement,
      remainingGoal,
      progress,
      qrText
    }
  };
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
