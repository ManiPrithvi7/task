import { logger } from '../src/utils/logger';
import { RedisService } from '../src/services/redisService';
import type { MqttClientManager } from '../src/servers/mqttClient';
import { formatInstagramScreenMqttPayload, type ScreenDeliveryFetchShape } from '../src/services/instagramService';
import { fetchInstagramProfileMetrics } from '../src/lib/socials/instagramMetrics';
import { ensureFreshInstagramAccessToken } from '../src/lib/socials/instagramTokenRefresh';
import { Device } from '../src/models/Device';
import { Social, Provider } from '../src/models/Social';
import mongoose from 'mongoose';
import { readStimCache, writeStimCache } from './cache';
import { calcResume, ceilingSequence, isAtOrPastTarget } from './math';
import { getRedisService } from '../src/services/redisService';

export const STIM_IG_LOCK_TTL_SEC = 3600;
const STIM_IG_LOCK_KEY_PREFIX = 'stim:ig:';

export interface IgDeviceMeta {
  deviceId: string;
  followers_count: number;
}

export async function resolveInstagramMeta(deviceId: string): Promise<{ accessToken: string; instagramAccountId: string; userId: string } | null> {
  const deviceDoc = await Device.findOne({ clientId: deviceId }).select({ userId: 1 }).lean();
  if (!deviceDoc?.userId) {
    logger.debug('[STIM_IG] No user linked to device', { deviceId });
    return null;
  }
  const userId = String(deviceDoc.userId);
  const uid = new mongoose.Types.ObjectId(userId);
  const social = await Social.findOne({ userId: uid, provider: Provider.INSTAGRAM })
    .select({ socialAccountId: 1, accessToken: 1, tokenExp: 1, tokenCreatedAt: 1 })
    .lean();
  if (!social?.accessToken) {
    logger.debug('[STIM_IG] No Instagram social for user', { deviceId, userId });
    return null;
  }
  const accessToken = await ensureFreshInstagramAccessToken({
    deviceId,
    accessToken: social.accessToken,
    userId,
    tokenExp: social.tokenExp,
    tokenCreatedAt: social.tokenCreatedAt,
  });
  return {
    accessToken,
    instagramAccountId: social.socialAccountId,
    userId,
  };
}

export async function fetchLiveFollowers(accessToken: string): Promise<number | null> {
  try {
    const result = await fetchInstagramProfileMetrics(accessToken);
    return result?.metrics?.followers_count ?? null;
  } catch (err: unknown) {
    logger.warn('[STIM_IG] fetchLiveFollowers failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

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

/** Also sync the `device:followers:*` Redis key so the main app's publishInstagramScreenIfChanged sees the new value. */
async function updateFollowerCache(deviceId: string, followers: number): Promise<void> {
  const redisSvc = getRedisService();
  if (!redisSvc?.isRedisConnected()) return;
  try {
    await redisSvc.getClient().set(`device:followers:${deviceId}`, String(followers));
  } catch { /* best-effort */ }
}

export async function runIgTick(
  deviceId: string,
  topicRoot: string,
  mqttClient: MqttClientManager,
  step: number,
  target: number,
  redis: RedisService,
): Promise<{ done: boolean; publishedCount: number }> {
  const meta = await resolveInstagramMeta(deviceId);
  if (!meta) {
    logger.info('[STIM_IG] No Instagram meta — skipping device', { deviceId });
    return { done: true, publishedCount: 0 };
  }

  const live = await fetchLiveFollowers(meta.accessToken);
  if (live === null) {
    logger.info('[STIM_IG] Could not fetch live followers — skip tick', { deviceId });
    return { done: false, publishedCount: 0 };
  }

  if (isAtOrPastTarget(live, target) && live > 0) {
    logger.info('[STIM_IG] Already at/past target — one sync publish then done', { deviceId, live, target });
    const { topic, payload } = buildStimIgPayload(deviceId, live, topicRoot);
    await mqttClient.publish({ topic, payload, qos: 1, retain: true });
    await updateFollowerCache(deviceId, live);
    writeStimCache('instagram', deviceId, { lastPublished: live, status: 'done' });
    return { done: true, publishedCount: 1 };
  }

  const cache = readStimCache('instagram', deviceId);
  const lastPub = cache?.lastPublished ?? 0;
  const resume = calcResume(live, lastPub, step);
  const ceiling = ceilingSequence(resume, target);

  // First tick: publish even when ceiling == live (cache was empty, device is new).
  // Subsequent ticks: only skip if we'd go backwards.
  if (cache && ceiling <= live) {
    logger.info('[STIM_IG] Ceiling ≤ live and already published — done', { deviceId, live, ceiling });
    writeStimCache('instagram', deviceId, { lastPublished: live, status: 'done' });
    return { done: true, publishedCount: 0 };
  }

  const publishValue = ceiling;

  const { topic, payload } = buildStimIgPayload(deviceId, publishValue, topicRoot);
  await mqttClient.publish({ topic, payload, qos: 1, retain: true });
  await updateFollowerCache(deviceId, publishValue);
  writeStimCache('instagram', deviceId, { lastPublished: publishValue, status: publishValue >= target ? 'done' : 'running' });

  logger.info('[STIM_IG] Published', { deviceId, followers: publishValue, target, done: publishValue >= target });
  return { done: publishValue >= target, publishedCount: 1 };
}
