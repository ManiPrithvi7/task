/**
 * Build MQTT screen_update payloads and publish when follower count changed.
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
  data?: { followers_count: number };
  error?: string;
  correlation_id?: string;
};

function calculateProgress(followers: number, target: number): number {
  return Math.min(100, Math.round((followers / target) * 100));
}

function getNextMilestone(followers: number): number {
  const milestones = [100, 500, 1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];
  return milestones.find((m) => m > followers) ?? Math.ceil(followers / 1000) * 1000 + 1000;
}

function generateMessage(followers: number): string {
  const target = getNextMilestone(followers);
  const remaining = target - followers;
  if (remaining <= 50) return `🎉 Almost at ${target >= 1000 ? Math.round(target / 1000) + 'k' : target}!`;
  if (target >= 1000) return `${remaining} away from ${Math.round(target / 1000)}k followers!`;
  return `${remaining} more to reach ${target} followers!`;
}

export function formatInstagramScreenMqttPayload(result: ScreenDeliveryFetchShape, topicRoot: string): { topic: string; payload: string } {
  const { deviceId, data } = result;
  const followers = data?.followers_count ?? 0;
  const target = getNextMilestone(followers);
  const progress = calculateProgress(followers, target);
  const isCelebration = progress >= 100;

  const inner = isCelebration
    ? {
        followers_count: followers,
        celebration_type: 'milestone',
        duration: 20,
        target,
        progress: 100,
        color_palette: 'instagram',
        message: '🎉 You made it!',
        animation: 'pulse_grow',
        sound: 'celebration.wav',
        url: 'https://instagram.com'
      }
    : {
        followers_count: followers,
        duration: 15,
        target,
        progress,
        color_palette: 'instagram',
        message: generateMessage(followers),
        animation: 'pulse_grow',
        url: 'https://instagram.com'
      };

  const payload: Record<string, unknown> = {
    version: '1.1',
    id: `msg_inst_${Date.now()}`,
    type: 'screen_update',
    screen: 'instagram',
    muted: false,
    timestamp: result.fetched_at,
    payload: inner
  };
  if (result.correlation_id) {
    payload.correlation_id = result.correlation_id;
  }

  return {
    topic: `${topicRoot}/${deviceId}/instagram`,
    payload: JSON.stringify(payload)
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
