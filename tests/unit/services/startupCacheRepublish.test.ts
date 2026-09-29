import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { devicesNeedingHydration } from '../../../src/services/startupCacheRepublish';
import { getIgDeviceRuntimeCache } from '../../../src/services/igDeviceRuntimeCache';
import * as stimDeviceCache from '../../../stimulate/stimDeviceCache';

describe('devicesNeedingHydration', () => {
  it('returns redis members missing from local set', () => {
    expect(devicesNeedingHydration(['a', 'b', 'c'], new Set(['b']))).toEqual(['a', 'c']);
  });

  it('drops blank members', () => {
    expect(devicesNeedingHydration(['  ', 'x', ''], new Set())).toEqual(['x']);
  });

  it('returns empty when all already local', () => {
    expect(devicesNeedingHydration(['a'], new Set(['a']))).toEqual([]);
  });
});

describe('republishCachedScreensForActiveDevices stim gate', () => {
  const deviceId = '274968B43A1D';

  beforeEach(() => {
    delete process.env.STIMULATE_DEVICE;
    stimDeviceCache._resetForTests();
    getIgDeviceRuntimeCache().delete(deviceId);
  });

  afterEach(() => {
    delete process.env.STIMULATE_DEVICE;
    stimDeviceCache._resetForTests();
    getIgDeviceRuntimeCache().delete(deviceId);
  });

  it('skips IG republish when only stim-origin followers remain and env unset', async () => {
    mock.module('../../../src/services/redisService', () => ({
      getRedisService: () => ({
        isRedisConnected: () => true,
        getClient: () => ({
          hGetAll: async () => ({
            ig_follower_count: '1139',
            ig_followers_origin: 'stim'
          }),
          sMembers: async () => []
        })
      })
    }));
    mock.module('../../../src/services/deviceService', () => ({
      getActiveDeviceCache: () => ({
        getAllActive: async () => [{ deviceId, businessId: 'biz', lastSeen: Date.now() }]
      })
    }));
    mock.module('../../../src/lib/socials/resolveDeviceGmb', () => ({
      resolveGmbContextForDevice: async () => null
    }));
    mock.module('../../../src/services/publishLoyaltyIdle', () => ({
      publishLoyaltyIdleForDevice: async () => undefined
    }));

    const publish = mock(async () => undefined);
    const mqttClient = { publish } as never;

    const { republishCachedScreensForActiveDevices } = await import(
      '../../../src/services/startupCacheRepublish'
    );
    const result = await republishCachedScreensForActiveDevices(mqttClient, 'proof.mqtt', true);

    expect(result.igPublished).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it('republishes IG from stim cache when device is allowlisted', async () => {
    process.env.STIMULATE_DEVICE = deviceId;
    await stimDeviceCache.set(deviceId, { igFollowerCount: 200, igFollowersOrigin: 'stim' });

    mock.module('../../../src/services/redisService', () => ({
      getRedisService: () => null
    }));
    mock.module('../../../src/services/deviceService', () => ({
      getActiveDeviceCache: () => ({
        getAllActive: async () => [{ deviceId, businessId: 'biz', lastSeen: Date.now() }]
      })
    }));
    mock.module('../../../src/lib/socials/resolveDeviceGmb', () => ({
      resolveGmbContextForDevice: async () => null
    }));
    mock.module('../../../src/services/publishLoyaltyIdle', () => ({
      publishLoyaltyIdleForDevice: async () => undefined
    }));

    const publish = mock(async () => undefined);
    const mqttClient = { publish } as never;

    const { republishCachedScreensForActiveDevices } = await import(
      '../../../src/services/startupCacheRepublish'
    );
    const result = await republishCachedScreensForActiveDevices(mqttClient, 'proof.mqtt', true);

    expect(result.igPublished).toBe(1);
    expect(publish).toHaveBeenCalled();
    const call = publish.mock.calls[0]?.[0] as { topic: string; payload: string };
    expect(call.topic).toBe(`proof.mqtt/${deviceId}/instagram`);
    expect(JSON.parse(call.payload).payload.followers).toBe(200);
  });
});
