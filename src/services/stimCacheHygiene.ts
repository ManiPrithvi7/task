/**
 * Startup hygiene for stim isolation:
 * 1. Purge stim namespace for devices no longer allowlisted (or all when env unset)
 * 2. Strip stim-polluted follower/review fields from the real device hash
 * 3. Publish correction MQTT so retain:true topics stop showing stim numbers
 */
import type { MqttClientManager } from '../servers/mqttClient';
import { REDIS_KEYS } from '../constants/redisKeys';
import { getRedisService } from './redisService';
import { getActiveDeviceCache } from './deviceService';
import {
  clearDeviceHashFields,
  getIgDeviceRuntimeCache,
  IG_STIM_POLLUTION_HASH_FIELDS,
  GMB_STIM_POLLUTION_HASH_FIELDS,
  isStimPollutedIgCount,
  isStimPollutedGmbCount
} from './igDeviceRuntimeCache';
import { formatInstagramScreenMqttPayload } from './instagramService';
import { publishGmbScreen } from '../webhooks/delivery/publishGmbScreen';
import { logger } from '../utils/logger';
import { isStimulateDevice, parseStimulateAllowlist } from '../utils/stimulateAllowlist';
import * as stimDeviceCache from '../../stimulate/stimDeviceCache';
import { clearAllStimCache, clearDeviceStimCache } from '../../stimulate/cache';

export type StimHygieneMqtt = {
  mqttClient: MqttClientManager;
  topicRoot: string;
  mqttPublishEnabled: boolean;
};

export async function runStimCacheStartupHygiene(opts?: StimHygieneMqtt): Promise<{
  purgedRedis: number;
  purgedLocal: number;
  strippedIg: number;
  strippedGmb: number;
  correctionIg: number;
  correctionGmb: number;
}> {
  const allowlist = new Set(parseStimulateAllowlist());
  const stimActive = await stimDeviceCache.listActive();

  let purgedRedis = 0;
  let purgedLocal = 0;

  if (allowlist.size === 0) {
    clearAllStimCache();
    const purged = await stimDeviceCache.purgeAll();
    purgedRedis = purged.redis;
    purgedLocal = purged.local;
  } else {
    stimDeviceCache.logStimCacheActive();
    const toDrop = stimActive.filter((id) => !allowlist.has(id));
    if (toDrop.length > 0) {
      for (const id of toDrop) clearDeviceStimCache(id);
      const purged = await stimDeviceCache.purgeAll(new Set(toDrop));
      purgedRedis = purged.redis;
      purgedLocal = purged.local;
    }
  }

  const deviceIds = new Set<string>();
  for (const d of await getActiveDeviceCache().getAllActive()) {
    deviceIds.add(d.deviceId);
  }
  const redisSvc = getRedisService();
  if (redisSvc?.isRedisConnected()) {
    try {
      const client = redisSvc.getClient();
      const members = await client.sMembers(REDIS_KEYS.activeDevices);
      for (const id of members) {
        if (id?.trim()) deviceIds.add(id.trim());
      }
      // SCAN all real device hashes — pollution may exist for devices no longer in active set
      for await (const key of client.scanIterator({ MATCH: 'proof.mqtt:device:*', COUNT: 100 })) {
        const keys = Array.isArray(key) ? key : [key];
        for (const k of keys) {
          const id = String(k).replace(/^proof\.mqtt:device:/, '').trim();
          // skip stim namespace keys if pattern ever overlaps (it shouldn't)
          if (id && !id.startsWith('stim:')) deviceIds.add(id);
        }
      }
    } catch {
      /* best-effort */
    }
  }

  let strippedIg = 0;
  let strippedGmb = 0;
  let correctionIg = 0;
  let correctionGmb = 0;
  const runtime = getIgDeviceRuntimeCache();

  for (const deviceId of deviceIds) {
    if (isStimulateDevice(deviceId)) continue;

    let hash: Record<string, string> = {};
    if (redisSvc?.isRedisConnected()) {
      try {
        hash = await redisSvc.getClient().hGetAll(REDIS_KEYS.deviceHash(deviceId));
      } catch {
        hash = {};
      }
    }

    // Also consider in-memory origin if hash empty (local-only pollution)
    const runtimeIgOrigin = runtime.getIgFollowersOrigin(deviceId);
    const runtimeGmbOrigin = runtime.getGmbReviewsOrigin(deviceId);
    const runtimeIg = runtime.getFollowers(deviceId);
    const runtimeGmb = runtime.getGmbReviewCount(deviceId);

    const igPolluted =
      isStimPollutedIgCount(hash) ||
      runtimeIgOrigin === 'stim' ||
      (runtimeIg != null &&
        runtimeIgOrigin == null &&
        !hash.ig_accountId?.trim() &&
        !runtime.get(deviceId)?.igAccountId?.trim());

    const gmbPolluted =
      isStimPollutedGmbCount(hash) ||
      runtimeGmbOrigin === 'stim' ||
      (runtimeGmb != null &&
        runtimeGmbOrigin == null &&
        !hash.gmb_profile_id?.trim() &&
        !runtime.get(deviceId)?.gmbProfileId?.trim());

    if (igPolluted) {
      const removed: string[] = [];
      if (hash.ig_follower_count) removed.push(`ig_follower_count=${hash.ig_follower_count}`);
      if (runtimeIg != null && !hash.ig_follower_count) removed.push(`runtime_ig=${runtimeIg}`);
      await clearDeviceHashFields(deviceId, [...IG_STIM_POLLUTION_HASH_FIELDS]);
      runtime.clearFollowerCount(deviceId);
      // Legacy string key from older follower cache
      if (redisSvc?.isRedisConnected()) {
        try {
          await redisSvc.getClient().del(REDIS_KEYS.deviceFollowers(deviceId));
        } catch {
          /* ignore */
        }
      }
      strippedIg += 1;
      logger.info('[STIM_CACHE] removed stim-polluted IG fields from real device cache', {
        deviceId,
        removed
      });

      if (opts?.mqttClient) {
        const { topic, payload } = formatInstagramScreenMqttPayload(
          {
            deviceId,
            success: true,
            fetched_at: new Date().toISOString(),
            data: { followers_count: 0, instagram_username: '' }
          },
          opts.topicRoot
        );
        try {
          await opts.mqttClient.publish({ topic, payload, qos: 1, retain: true });
          correctionIg += 1;
          logger.info('[STIM_CACHE] published IG correction/reset after stim strip', {
            deviceId,
            followers: 0
          });
        } catch (err: unknown) {
          logger.warn('[STIM_CACHE] IG correction publish failed', {
            deviceId,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    }

    if (gmbPolluted) {
      const removed: string[] = [];
      if (hash.gmb_review_count) removed.push(`gmb_review_count=${hash.gmb_review_count}`);
      if (runtimeGmb != null && !hash.gmb_review_count) removed.push(`runtime_gmb=${runtimeGmb}`);
      await clearDeviceHashFields(deviceId, [...GMB_STIM_POLLUTION_HASH_FIELDS]);
      runtime.clearGmbReviewCount(deviceId);
      strippedGmb += 1;
      logger.info('[STIM_CACHE] removed stim-polluted GMB fields from real device cache', {
        deviceId,
        removed
      });

      if (opts?.mqttClient && opts.mqttPublishEnabled) {
        try {
          await publishGmbScreen(
            opts.mqttClient,
            opts.topicRoot,
            deviceId,
            { verifiedReview: 0, rating: 0 },
            opts.mqttPublishEnabled
          );
          correctionGmb += 1;
          logger.info('[STIM_CACHE] published GMB correction/reset after stim strip', {
            deviceId,
            verifiedReview: 0
          });
        } catch (err: unknown) {
          logger.warn('[STIM_CACHE] GMB correction publish failed', {
            deviceId,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    }
  }

  return {
    purgedRedis,
    purgedLocal,
    strippedIg,
    strippedGmb,
    correctionIg,
    correctionGmb
  };
}
