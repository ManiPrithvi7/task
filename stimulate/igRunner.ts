import { logger } from '../src/utils/logger';
import { RedisService } from '../src/services/redisService';
import type { MqttClientManager } from '../src/servers/mqttClient';
import {
  formatInstagramScreenMqttPayload,
  type ScreenDeliveryFetchShape
} from '../src/services/instagramService';
import { readStimCache, writeStimCache } from './cache';
import { calcResume, ceilingSequence } from './math';
import { getRedisService } from '../src/services/redisService';
import { instagramFollowerMetrics, resolveCelebrationState } from '../src/services/screenEnvelope';

export const STIM_IG_LOCK_TTL_SEC = 3600;
const STIM_IG_LOCK_KEY_PREFIX = 'stim:ig:';

/** Same envelope builder as production IG MQTT. */
export function buildStimIgPayload(
  deviceId: string,
  followers: number,
  topicRoot: string,
): { topic: string; payload: string } {
  const shape: ScreenDeliveryFetchShape = {
    deviceId,
    success: true,
    fetched_at: new Date().toISOString(),
    data: { followers_count: followers, instagram_username: '' },
  };
  return formatInstagramScreenMqttPayload(shape, topicRoot);
}

export async function ensureStimIgLock(redis: RedisService, deviceId: string): Promise<boolean> {
  const key = `${STIM_IG_LOCK_KEY_PREFIX}${deviceId}`;
  try {
    const ok = await redis.getClient().set(key, '1', { NX: true, EX: STIM_IG_LOCK_TTL_SEC });
    return ok !== null;
  } catch {
    return false;
  }
}

export function releaseStimIgLock(redis: RedisService, deviceId: string): Promise<number> {
  return redis.getClient().del(`${STIM_IG_LOCK_KEY_PREFIX}${deviceId}`);
}

export function igStimLockKey(deviceId: string): string {
  return `${STIM_IG_LOCK_KEY_PREFIX}${deviceId}`;
}

async function updateFollowerCache(deviceId: string, followers: number): Promise<void> {
  const redisSvc = getRedisService();
  if (!redisSvc?.isRedisConnected()) return;
  try {
    await redisSvc.getClient().set(`device:followers:${deviceId}`, String(followers));
  } catch { /* best-effort */ }
}

/**
 * Stim always ramps from in-memory progress (baseline 0), credentials or not.
 * @deprecated kept for tests that still call it — always synthetic.
 */
export async function resolveLiveFollowersForStim(
  deviceId: string
): Promise<{ live: number; mode: 'synthetic' }> {
  logger.debug('[STIM_IG] Synthetic ramp (credentials ignored)', { deviceId });
  return { live: 0, mode: 'synthetic' };
}

export async function runIgTick(
  deviceId: string,
  topicRoot: string,
  mqttClient: MqttClientManager,
  step: number,
  target: number,
  _redis: RedisService,
): Promise<{ done: boolean; publishedCount: number }> {
  const cache = readStimCache('instagram', deviceId);
  if (cache?.status === 'done') {
    return { done: true, publishedCount: 0 };
  }

  const lastPub = cache?.lastPublished ?? 2;
  // ponytail: live always 0 — credentials never gate or floor the ramp
  const publishValue = ceilingSequence(calcResume(0, lastPub, step), target);

  const { topic, payload } = buildStimIgPayload(deviceId, publishValue, topicRoot);
  await mqttClient.publish({ topic, payload, qos: 1, retain: true });
  await updateFollowerCache(deviceId, publishValue);
  writeStimCache('instagram', deviceId, {
    lastPublished: publishValue,
    status: publishValue >= target ? 'done' : 'running',
  });

  logger.info('[STIM_IG] Published', {
    deviceId,
    followers: publishValue,
    target,
    mode: 'synthetic',
    achievement: instagramFollowerMetrics(publishValue).nextGoal,
    celebration: resolveCelebrationState('instagram', publishValue).celebration,
    done: publishValue >= target,
  });
  return { done: publishValue >= target, publishedCount: 1 };
}
