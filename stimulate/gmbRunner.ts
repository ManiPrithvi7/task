import { logger } from '../src/utils/logger';
import { RedisService } from '../src/services/redisService';
import type { MqttClientManager } from '../src/servers/mqttClient';
import { publishGmbScreen } from '../src/webhooks/delivery/publishGmbScreen';
import { resolveGmbContextForDevice } from '../src/lib/socials/resolveDeviceGmb';
import { readStimCache, writeStimCache } from './cache';
import { calcResume, ceilingSequence, isAtOrPastTarget } from './math';
import { getRedisService } from '../src/services/redisService';
import { resolveCelebrationState } from '../src/services/screenEnvelope';

export const STIM_GMB_LOCK_TTL_SEC = 3600;
const STIM_GMB_LOCK_KEY_PREFIX = 'stim:gmb:';

export function releaseStimGmbLock(redis: RedisService, deviceId: string): Promise<number> {
  return redis.getClient().del(`${STIM_GMB_LOCK_KEY_PREFIX}${deviceId}`);
}

export async function ensureStimGmbLock(redis: RedisService, deviceId: string): Promise<boolean> {
  const key = `${STIM_GMB_LOCK_KEY_PREFIX}${deviceId}`;
  try {
    const ok = await redis.getClient().set(key, '1', { NX: true, EX: STIM_GMB_LOCK_TTL_SEC });
    return ok !== null;
  } catch {
    return false;
  }
}

export function gmbStimLockKey(deviceId: string): string {
  return `${STIM_GMB_LOCK_KEY_PREFIX}${deviceId}`;
}

async function updateGmbCache(deviceId: string, reviews: number): Promise<void> {
  const redisSvc = getRedisService();
  if (!redisSvc?.isRedisConnected()) return;
  try {
    await redisSvc.getClient().set(`gmb:reviews:${deviceId}`, String(reviews));
  } catch { /* best-effort */ }
}

export async function runGmbTick(
  deviceId: string,
  topicRoot: string,
  mqttClient: MqttClientManager,
  mqttPublishEnabled: boolean,
  step: number,
  target: number,
  redis: RedisService,
): Promise<{ done: boolean; publishedCount: number }> {
  const ctx = await resolveGmbContextForDevice(deviceId);
  const synthetic = !ctx;
  if (synthetic) {
    logger.info('[STIM_GMB] No GMB connection — synthetic ramp from 0', { deviceId });
  }

  const live = ctx?.verifiedReviewCount ?? 0;
  const rating = ctx?.averageRating ?? 4;

  if (isAtOrPastTarget(live, target) && live > 0) {
    logger.info('[STIM_GMB] Already at/past target — one sync publish then done', { deviceId, live, target });
    await publishGmbScreen(mqttClient, topicRoot, deviceId, {
      verifiedReview: live,
      rating,
    }, mqttPublishEnabled);
    await updateGmbCache(deviceId, live);
    writeStimCache('gmb', deviceId, { lastPublished: live, status: 'done' });
    return { done: true, publishedCount: 1 };
  }

  const cache = readStimCache('gmb', deviceId);
  const lastPub = cache?.lastPublished ?? 0;
  const resume = calcResume(live, lastPub, step);
  const ceiling = ceilingSequence(resume, target);

  // First tick: publish even when ceiling == live (cache was empty, device is new).
  // Subsequent ticks: only skip if we'd go backwards.
  if (cache && ceiling <= live) {
    logger.info('[STIM_GMB] Ceiling ≤ live and already published — done', { deviceId, live, ceiling });
    writeStimCache('gmb', deviceId, { lastPublished: live, status: 'done' });
    return { done: true, publishedCount: 0 };
  }

  const publishValue = ceiling;

  await publishGmbScreen(
    mqttClient, topicRoot, deviceId,
    { verifiedReview: publishValue, rating },
    mqttPublishEnabled,
  );

  await updateGmbCache(deviceId, publishValue);
  writeStimCache('gmb', deviceId, { lastPublished: publishValue, status: publishValue >= target ? 'done' : 'running' });

  logger.info('[STIM_GMB] Published', {
    deviceId,
    reviews: publishValue,
    target,
    mode: synthetic ? 'synthetic' : 'live',
    celebration: resolveCelebrationState('gmb', publishValue).celebration,
    done: publishValue >= target
  });
  return { done: publishValue >= target, publishedCount: 1 };
}
