import { logger } from '../src/utils/logger';
import { RedisService } from '../src/services/redisService';
import type { MqttClientManager } from '../src/servers/mqttClient';
import { publishGmbScreen } from '../src/webhooks/delivery/publishGmbScreen';
import { readStimCache, writeStimCache } from './cache';
import { calcResume, ceilingSequence } from './math';
import { resolveCelebrationState } from '../src/services/screenEnvelope';
import { getLocalStimLock } from '../src/services/localCaches';
import { getIgDeviceRuntimeCache } from '../src/services/igDeviceRuntimeCache';

export const STIM_GMB_LOCK_TTL_SEC = 3600;
const STIM_GMB_LOCK_KEY_PREFIX = 'stim:gmb:';

export function releaseStimGmbLock(_redis: RedisService, deviceId: string): Promise<number> {
  getLocalStimLock().release(deviceId, 'gmb');
  return Promise.resolve(1);
}

export async function ensureStimGmbLock(_redis: RedisService, deviceId: string): Promise<boolean> {
  return getLocalStimLock().tryAcquire(deviceId, 'gmb', STIM_GMB_LOCK_TTL_SEC * 1000);
}

export function gmbStimLockKey(deviceId: string): string {
  return `${STIM_GMB_LOCK_KEY_PREFIX}${deviceId}`;
}

async function updateGmbCache(deviceId: string, reviews: number): Promise<void> {
  const runtime = getIgDeviceRuntimeCache();
  runtime.setGmbReviewCount(deviceId, reviews);
  runtime.markDirty(deviceId, 'gmb_review_count');
}

export async function runGmbTick(
  deviceId: string,
  topicRoot: string,
  mqttClient: MqttClientManager,
  mqttPublishEnabled: boolean,
  step: number,
  target: number,
  _redis: RedisService | null,
): Promise<{ done: boolean; publishedCount: number }> {
  const cache = readStimCache('gmb', deviceId);
  if (cache?.status === 'done') {
    return { done: true, publishedCount: 0 };
  }

  const lastPub = cache?.lastPublished ?? 0;
  // ponytail: live always 0 — credentials never gate or floor the ramp
  const publishValue = ceilingSequence(calcResume(0, lastPub, step), target);
  const rating = 4;

  await publishGmbScreen(
    mqttClient,
    topicRoot,
    deviceId,
    { verifiedReview: publishValue, rating },
    mqttPublishEnabled,
  );

  await updateGmbCache(deviceId, publishValue);
  writeStimCache('gmb', deviceId, {
    lastPublished: publishValue,
    status: publishValue >= target ? 'done' : 'running',
  });

  logger.info('[STIM_GMB] Published', {
    deviceId,
    reviews: publishValue,
    target,
    mode: 'synthetic',
    celebration: resolveCelebrationState('gmb', publishValue).celebration,
    done: publishValue >= target,
  });
  return { done: publishValue >= target, publishedCount: 1 };
}
