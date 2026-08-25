import mongoose from 'mongoose';
import { Social, Provider } from '../models/Social';
import { getActiveDeviceCache } from './deviceService';
import { getIgDeviceRuntimeCache } from './igDeviceRuntimeCache';
import { getIgAccountFetchCoordinator } from './igAccountFetchCoordinator';
import { getRedisService } from './redisService';
import { REDIS_KEYS } from '../constants/redisKeys';
import type { InstagramPoller } from './instagramService';
import { logger } from '../utils/logger';

let pollerRef: InstagramPoller | null = null;
let priorityTtlMs = 120_000;

export function registerIgIntegrationLifecycle(deps: {
  instagramPoller: InstagramPoller | null;
  instagramPriorityTtlMs?: number;
}): void {
  pollerRef = deps.instagramPoller;
  if (deps.instagramPriorityTtlMs && deps.instagramPriorityTtlMs > 0) {
    priorityTtlMs = deps.instagramPriorityTtlMs;
  }
}

export async function onInstagramConnected(userId: string): Promise<void> {
  const poller = pollerRef;
  if (!poller) {
    logger.debug('[IG_LIFECYCLE] Connect — poller not available', { userId });
    return;
  }

  const devices = await getActiveDeviceCache().getAllActive();
  const userDevices = devices.filter((d) => d.userId === userId);
  if (userDevices.length === 0) {
    logger.info('[IG_LIFECYCLE] Connect — no active devices for user', { userId });
    return;
  }

  await Promise.allSettled(
    userDevices.map(async (d) => {
      try {
        await poller.markPriority(d.deviceId, priorityTtlMs);
        await poller.requestImmediateFetch(d.deviceId, { trigger: 'connect' });
      } catch (err: unknown) {
        logger.warn('[IG_LIFECYCLE] Connect fetch failed for device', {
          userId,
          deviceId: d.deviceId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    })
  );

  logger.info('[IG_LIFECYCLE] Connect — immediate fetch queued', {
    userId,
    deviceCount: userDevices.length
  });
}

export async function onInstagramDisconnected(userId: string): Promise<void> {
  let socialAccountId: string | undefined;
  if (mongoose.Types.ObjectId.isValid(userId)) {
    const social = await Social.findOne({
      userId: new mongoose.Types.ObjectId(userId),
      provider: Provider.INSTAGRAM
    })
      .select({ socialAccountId: 1 })
      .lean();
    socialAccountId = social?.socialAccountId;
  }

  if (socialAccountId) {
    getIgAccountFetchCoordinator().purge(socialAccountId);
  }

  const devices = await getActiveDeviceCache().getAllActive();
  const userDevices = devices.filter((d) => d.userId === userId);
  const runtime = getIgDeviceRuntimeCache();
  const redisSvc = getRedisService();

  for (const d of userDevices) {
    runtime.set(d.deviceId, { igFollowerCount: undefined });
    runtime.markDirty(d.deviceId, 'ig_follower_count');

    if (redisSvc?.isRedisConnected()) {
      try {
        const client = redisSvc.getClient();
        await client.zRem(REDIS_KEYS.priorityZset, d.deviceId);
        await client.hDel(REDIS_KEYS.deviceHash(d.deviceId), 'ig_follower_count');
      } catch (err: unknown) {
        logger.debug('[IG_LIFECYCLE] Redis purge failed', {
          deviceId: d.deviceId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  logger.info('[IG_LIFECYCLE] Disconnect — caches purged', {
    userId,
    deviceCount: userDevices.length,
    socialAccountId
  });
}
