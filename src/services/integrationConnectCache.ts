import { Provider } from '../models/Social';
import { Device } from '../models/Device';
import { cacheUserIntegrations, applySocialDisconnected } from './userIntegrationCache';
import { getActiveDeviceCache, type ActiveDevice } from './deviceService';
import {
  writeDeviceHashOnConnect,
  getIgDeviceRuntimeCache,
  clearDeviceHashFields,
  IG_DISCONNECT_HASH_FIELDS,
  GMB_DISCONNECT_HASH_FIELDS
} from './igDeviceRuntimeCache';
import { getRedisService } from './redisService';
import { REDIS_KEYS } from '../constants/redisKeys';
import { shouldSkipForStimulate } from '../utils/stimulateAllowlist';
import { logger } from '../utils/logger';

export type IntegrationConnectCacheInput = {
  userId: string;
  provider: Provider;
  socialAccountId: string;
  accessToken: string;
  gmbLocationId?: string;
};

export type IntegrationConnectCacheDeps = {
  cacheUserIntegrations: (userId: string) => Promise<unknown>;
  getAllActive: () => Promise<ActiveDevice[]>;
  setActive: (device: ActiveDevice) => Promise<boolean>;
  writeDeviceHash: (deviceId: string, fields: Record<string, string>) => Promise<void>;
  setIgNoCredentials: (deviceId: string, absent: boolean) => void;
  shouldSkip: (deviceId: string, platform: 'instagram' | 'gmb') => Promise<boolean>;
};

function defaultDeps(): IntegrationConnectCacheDeps {
  return {
    cacheUserIntegrations,
    getAllActive: () => getActiveDeviceCache().getAllActive(),
    setActive: (device) => getActiveDeviceCache().setActive(device),
    writeDeviceHash: writeDeviceHashOnConnect,
    setIgNoCredentials: (deviceId, absent) =>
      getIgDeviceRuntimeCache().setIgNoCredentials(deviceId, absent),
    shouldSkip: shouldSkipForStimulate
  };
}

/** Rebuild user integrations + push tokens onto online devices (local + Redis hash). */
export async function applyIntegrationConnectCache(
  input: IntegrationConnectCacheInput,
  deps: IntegrationConnectCacheDeps = defaultDeps()
): Promise<{ deviceIds: string[] }> {
  await deps.cacheUserIntegrations(input.userId);

  const active = await deps.getAllActive();
  const matched = active.filter((d) => d.businessId === input.userId);
  const deviceIds: string[] = [];

  for (const device of matched) {
    const platform = input.provider === Provider.INSTAGRAM ? 'instagram' : 'gmb';
    if (await deps.shouldSkip(device.deviceId, platform)) continue;

    const fields: Record<string, string> = {
      business_id: input.userId,
      status: 'active'
    };

    if (input.provider === Provider.INSTAGRAM) {
      fields.ig_accountId = input.socialAccountId;
      fields.ig_accessToken = input.accessToken;
      await deps.writeDeviceHash(device.deviceId, fields);
      deps.setIgNoCredentials(device.deviceId, false);
      await deps.setActive({
        ...device,
        instagramAccountId: input.socialAccountId,
        accessToken: input.accessToken
      });
    } else {
      fields.gmb_accessToken = input.accessToken;
      if (input.gmbLocationId) fields.gmb_profile_id = input.gmbLocationId;
      await deps.writeDeviceHash(device.deviceId, fields);
    }

    deviceIds.push(device.deviceId);
  }

  logger.info('[INTEGRATIONS_CONNECT] Session cache updated', {
    userId: input.userId,
    provider: input.provider,
    socialAccountId: input.socialAccountId,
    deviceCount: deviceIds.length
  });

  return { deviceIds };
}

export type IntegrationDisconnectCacheInput = {
  userId: string;
  provider: Provider;
  socialAccountId?: string;
};

export type IntegrationDisconnectCacheDeps = {
  applySocialDisconnected: (userId: string, provider: Provider) => Promise<unknown>;
  findDeviceClientIds: (userId: string) => Promise<string[]>;
  getAllActive: () => Promise<ActiveDevice[]>;
  setActive: (device: ActiveDevice) => Promise<boolean>;
  clearHashFields: (deviceId: string, fields: readonly string[]) => Promise<void>;
  deleteKeys: (keys: string[]) => Promise<void>;
  setIgNoCredentials: (deviceId: string, absent: boolean) => void;
  getGmbProfileId: (deviceId: string) => string | undefined;
};

async function defaultFindDeviceClientIds(userId: string): Promise<string[]> {
  const docs = await Device.find({ businessId: userId }).select({ clientId: 1 }).lean();
  return docs.map((d) => d.clientId).filter((id): id is string => Boolean(id));
}

async function defaultDeleteKeys(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const redisSvc = getRedisService();
  if (!redisSvc?.isRedisConnected()) return;
  try {
    await redisSvc.getClient().del(keys);
  } catch (err: unknown) {
    logger.debug('[INTEGRATIONS_DISCONNECT] Redis DEL failed', {
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

function defaultDisconnectDeps(): IntegrationDisconnectCacheDeps {
  return {
    applySocialDisconnected,
    findDeviceClientIds: defaultFindDeviceClientIds,
    getAllActive: () => getActiveDeviceCache().getAllActive(),
    setActive: (device) => getActiveDeviceCache().setActive(device),
    clearHashFields: clearDeviceHashFields,
    deleteKeys: defaultDeleteKeys,
    setIgNoCredentials: (deviceId, absent) =>
      getIgDeviceRuntimeCache().setIgNoCredentials(deviceId, absent),
    getGmbProfileId: (deviceId) => getIgDeviceRuntimeCache().get(deviceId)?.gmbProfileId
  };
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => id.trim().length > 0))];
}

/** Drop one provider from user + device caches (Redis hash fields + local session). */
export async function applyIntegrationDisconnectCache(
  input: IntegrationDisconnectCacheInput,
  deps: IntegrationDisconnectCacheDeps = defaultDisconnectDeps()
): Promise<{ deviceIds: string[]; onlineDeviceIds: string[] }> {
  await deps.applySocialDisconnected(input.userId, input.provider);

  const active = await deps.getAllActive();
  const online = active.filter((d) => d.businessId === input.userId);
  const onlineDeviceIds = uniqueIds(online.map((d) => d.deviceId));
  const fromMongo = await deps.findDeviceClientIds(input.userId);
  const deviceIds = uniqueIds([...fromMongo, ...onlineDeviceIds]);

  const isIg = input.provider === Provider.INSTAGRAM;
  const hashFields = isIg ? IG_DISCONNECT_HASH_FIELDS : GMB_DISCONNECT_HASH_FIELDS;
  const onlineById = new Map(online.map((d) => [d.deviceId, d]));

  for (const deviceId of deviceIds) {
    const extraKeys: string[] = [];
    if (isIg) {
      extraKeys.push(REDIS_KEYS.deviceFollowers(deviceId));
    } else {
      const locationId = deps.getGmbProfileId(deviceId)?.trim();
      if (locationId) extraKeys.push(REDIS_KEYS.gmbReviews(locationId));
    }

    await deps.clearHashFields(deviceId, hashFields);
    await deps.deleteKeys(extraKeys);

    if (isIg) {
      deps.setIgNoCredentials(deviceId, true);
      const existing = onlineById.get(deviceId);
      if (existing) {
        await deps.setActive({
          ...existing,
          instagramAccountId: undefined,
          accessToken: undefined
        });
      }
    }
  }

  logger.info('[INTEGRATIONS_DISCONNECT] Session cache cleared', {
    userId: input.userId,
    provider: input.provider,
    socialAccountId: input.socialAccountId,
    deviceCount: deviceIds.length,
    onlineCount: onlineDeviceIds.length
  });

  return { deviceIds, onlineDeviceIds };
}
