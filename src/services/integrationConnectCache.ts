import { Provider } from '../models/Social';
import { cacheUserIntegrations } from './userIntegrationCache';
import { getActiveDeviceCache, type ActiveDevice } from './deviceService';
import { writeDeviceHashOnConnect, getIgDeviceRuntimeCache } from './igDeviceRuntimeCache';
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
