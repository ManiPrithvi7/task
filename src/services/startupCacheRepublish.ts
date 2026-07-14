/**
 * After process restart: recover who was active from Redis and republish
 * last-known screen payloads without waiting for Graph/GBP live fetches.
 *
 * ponytail: Redis set + follower/review keys are the restart source of truth;
 * live poller/webhooks catch up afterward.
 */
import type { MqttClientManager } from '../servers/mqttClient';
import { getActiveDeviceCache, type ActiveDevice } from './deviceService';
import { getRedisService } from './redisService';
import { formatInstagramScreenMqttPayload } from './instagramService';
import { getUserIntegrations } from './userIntegrationCache';
import { resolveGmbContextForDevice } from '../lib/socials/resolveDeviceGmb';
import { publishGmbScreen } from '../webhooks/delivery/publishGmbScreen';
import { getGmbReviewCount } from '../webhooks/gmbReviewCache';
import { logger } from '../utils/logger';
import { shouldSkipForStimulate } from '../utils/stimulateAllowlist';

export const REDIS_ACTIVE_DEVICES_SET = 'proof.mqtt:active:devices';

export type HydrateActiveDeviceFn = (deviceId: string) => Promise<void>;

/** Minimal Redis surface used for active-set restore. */
export type ActiveSetRedisClient = {
  sMembers(key: string): Promise<string[]>;
};

/** Pure: Redis members not already present locally. */
export function devicesNeedingHydration(
  redisMembers: string[],
  localDeviceIds: ReadonlySet<string>
): string[] {
  const out: string[] = [];
  for (const id of redisMembers) {
    const deviceId = id?.trim();
    if (!deviceId) continue;
    if (localDeviceIds.has(deviceId)) continue;
    out.push(deviceId);
  }
  return out;
}

/** Merge Redis `proof.mqtt:active:devices` into local active-device cache (does not wipe local). */
export async function restoreActiveDevicesFromRedis(
  redisClient: ActiveSetRedisClient | null,
  hydrate: HydrateActiveDeviceFn
): Promise<{ redisActiveCount: number; hydrated: number }> {
  if (!redisClient) {
    return { redisActiveCount: 0, hydrated: 0 };
  }

  let members: string[] = [];
  try {
    members = await redisClient.sMembers(REDIS_ACTIVE_DEVICES_SET);
  } catch (err: unknown) {
    logger.warn('[STARTUP_CACHE] Failed to read active device set', {
      error: err instanceof Error ? err.message : String(err)
    });
    return { redisActiveCount: 0, hydrated: 0 };
  }

  const cache = getActiveDeviceCache();
  const local = await cache.getAllActive();
  const localIds = new Set(local.map((d) => d.deviceId));
  const need = devicesNeedingHydration(members, localIds);

  let hydrated = 0;
  for (const deviceId of need) {
    try {
      await hydrate(deviceId);
      hydrated += 1;
    } catch (err: unknown) {
      logger.warn('[STARTUP_CACHE] Failed to hydrate active device', {
        deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  logger.info('[STARTUP_CACHE] Restored active devices from Redis', {
    redisActiveCount: members.length,
    hydrated,
    localActiveCount: await cache.count()
  });

  return { redisActiveCount: members.length, hydrated };
}

async function republishInstagramFromFollowersCache(
  deviceId: string,
  topicRoot: string,
  mqttClient: MqttClientManager
): Promise<boolean> {
  if (await shouldSkipForStimulate(deviceId, 'instagram')) return false;

  const redisSvc = getRedisService();
  if (!redisSvc?.isRedisConnected()) return false;

  let raw: string | null = null;
  try {
    raw = await redisSvc.getClient().get(`device:followers:${deviceId}`);
  } catch {
    return false;
  }
  if (raw === null) return false;
  const followers = parseInt(raw, 10);
  if (!Number.isFinite(followers) || followers < 0) return false;

  const { topic, payload } = formatInstagramScreenMqttPayload(
    {
      deviceId,
      success: true,
      fetched_at: new Date().toISOString(),
      data: { followers_count: followers, instagram_username: '' }
    },
    topicRoot
  );

  await mqttClient.publish({ topic, payload, qos: 1, retain: true });
  try {
    await redisSvc.getClient().set(`ig:last_pub:${deviceId}`, String(Date.now()), { EX: 86400 });
  } catch {
    /* best-effort */
  }
  logger.info('[STARTUP_CACHE] Republished Instagram from Redis followers cache', {
    deviceId,
    followers
  });
  return true;
}

async function republishGmbFromCache(
  device: ActiveDevice,
  topicRoot: string,
  mqttClient: MqttClientManager,
  mqttPublishEnabled: boolean
): Promise<boolean> {
  if (await shouldSkipForStimulate(device.deviceId, 'gmb')) return false;

  const ctx = await resolveGmbContextForDevice(device.deviceId);
  if (!ctx) return false;

  let verifiedReview = ctx.verifiedReviewCount;
  const integrations = device.userId ? await getUserIntegrations(device.userId) : null;
  const locationId = integrations?.gmb?.locationId;
  if (locationId) {
    const cached = await getGmbReviewCount(locationId);
    if (cached !== null) verifiedReview = cached;
  }

  await publishGmbScreen(
    mqttClient,
    topicRoot,
    device.deviceId,
    {
      verifiedReview,
      rating: ctx.averageRating,
      celebration: 'false'
    },
    mqttPublishEnabled
  );
  logger.info('[STARTUP_CACHE] Republished GMB from cache', {
    deviceId: device.deviceId,
    verifiedReview,
    fromRedisLocation: Boolean(locationId)
  });
  return true;
}

/**
 * For every locally active device, push last-known IG/GMB screens from Redis/Mongo
 * so displays that stayed MQTT-connected after a server restart get values immediately.
 */
export async function republishCachedScreensForActiveDevices(
  mqttClient: MqttClientManager,
  topicRoot: string,
  mqttPublishEnabled: boolean
): Promise<{ igPublished: number; gmbPublished: number; deviceCount: number }> {
  const devices = await getActiveDeviceCache().getAllActive();
  let igPublished = 0;
  let gmbPublished = 0;

  for (const device of devices) {
    try {
      if (await republishInstagramFromFollowersCache(device.deviceId, topicRoot, mqttClient)) {
        igPublished += 1;
      }
    } catch (err: unknown) {
      logger.warn('[STARTUP_CACHE] Instagram republish failed', {
        deviceId: device.deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
    }

    try {
      if (await republishGmbFromCache(device, topicRoot, mqttClient, mqttPublishEnabled)) {
        gmbPublished += 1;
      }
    } catch (err: unknown) {
      logger.warn('[STARTUP_CACHE] GMB republish failed', {
        deviceId: device.deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  logger.info('[STARTUP_CACHE] Startup cache republish complete', {
    deviceCount: devices.length,
    igPublished,
    gmbPublished
  });

  return { igPublished, gmbPublished, deviceCount: devices.length };
}
