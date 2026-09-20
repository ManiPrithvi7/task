import { describe, expect, it, mock } from 'bun:test';
import { Provider } from '../../../src/models/Social';
import {
  applyIntegrationConnectCache,
  applyIntegrationDisconnectCache
} from '../../../src/services/integrationConnectCache';
import type { ActiveDevice } from '../../../src/services/deviceService';
import type {
  IntegrationConnectCacheDeps,
  IntegrationDisconnectCacheDeps
} from '../../../src/services/integrationConnectCache';

function device(id: string, businessId: string): ActiveDevice {
  return { deviceId: id, businessId, lastSeen: Date.now() };
}

describe('applyIntegrationConnectCache', () => {
  it('writes Instagram tokens onto matching online devices and skips stim', async () => {
    const writeDeviceHash = mock(async () => {});
    const setActive = mock(async () => true);
    const setIgNoCredentials = mock(() => {});
    const cacheUserIntegrations = mock(async () => ({}));

    const deps: IntegrationConnectCacheDeps = {
      cacheUserIntegrations,
      getAllActive: async () => [
        device('online-1', 'biz-1'),
        device('other-biz', 'biz-2'),
        device('stim-1', 'biz-1')
      ],
      setActive,
      writeDeviceHash,
      setIgNoCredentials,
      shouldSkip: async (deviceId) => deviceId === 'stim-1'
    };

    const result = await applyIntegrationConnectCache(
      {
        userId: 'biz-1',
        provider: Provider.INSTAGRAM,
        socialAccountId: 'ig-acc',
        accessToken: 'tok'
      },
      deps
    );

    expect(result.deviceIds).toEqual(['online-1']);
    expect(cacheUserIntegrations).toHaveBeenCalledWith('biz-1');
    expect(writeDeviceHash).toHaveBeenCalledTimes(1);
    expect(writeDeviceHash.mock.calls[0][0]).toBe('online-1');
    expect(writeDeviceHash.mock.calls[0][1]).toMatchObject({
      ig_accountId: 'ig-acc',
      ig_accessToken: 'tok',
      business_id: 'biz-1'
    });
    expect(setIgNoCredentials).toHaveBeenCalledWith('online-1', false);
    expect(setActive).toHaveBeenCalledTimes(1);
  });

  it('writes GMB token and location id without mutating local IG fields', async () => {
    const writeDeviceHash = mock(async () => {});
    const setActive = mock(async () => true);
    const deps: IntegrationConnectCacheDeps = {
      cacheUserIntegrations: mock(async () => ({})),
      getAllActive: async () => [device('d1', 'biz-1')],
      setActive,
      writeDeviceHash,
      setIgNoCredentials: mock(() => {}),
      shouldSkip: async () => false
    };

    await applyIntegrationConnectCache(
      {
        userId: 'biz-1',
        provider: Provider.GOOGLE_BUSINESS,
        socialAccountId: 'gmb-acc',
        accessToken: 'gmb-tok',
        gmbLocationId: 'loc-9'
      },
      deps
    );

    expect(writeDeviceHash.mock.calls[0][1]).toMatchObject({
      gmb_accessToken: 'gmb-tok',
      gmb_profile_id: 'loc-9'
    });
    expect(setActive).not.toHaveBeenCalled();
  });
});

describe('applyIntegrationDisconnectCache', () => {
  it('clears Instagram hash fields for mongo + online devices and strips active tokens', async () => {
    const clearHashFields = mock(async () => {});
    const deleteKeys = mock(async () => {});
    const setActive = mock(async () => true);
    const setIgNoCredentials = mock(() => {});
    const applySocialDisconnected = mock(async () => ({}));

    const deps: IntegrationDisconnectCacheDeps = {
      applySocialDisconnected,
      findDeviceClientIds: async () => ['offline-1', 'online-1'],
      getAllActive: async () => [
        device('online-1', 'biz-1'),
        device('other-biz', 'biz-2')
      ],
      setActive,
      clearHashFields,
      deleteKeys,
      setIgNoCredentials,
      getGmbProfileId: () => undefined
    };

    const result = await applyIntegrationDisconnectCache(
      { userId: 'biz-1', provider: Provider.INSTAGRAM, socialAccountId: 'ig-acc' },
      deps
    );

    expect(result.onlineDeviceIds).toEqual(['online-1']);
    expect(result.deviceIds.sort()).toEqual(['offline-1', 'online-1']);
    expect(applySocialDisconnected).toHaveBeenCalledWith('biz-1', Provider.INSTAGRAM);
    expect(clearHashFields).toHaveBeenCalledTimes(2);
    expect(clearHashFields.mock.calls[0][1]).toEqual([
      'ig_accountId',
      'ig_accessToken',
      'ig_follower_count'
    ]);
    expect(deleteKeys.mock.calls.some((c) => c[0].includes('device:followers:online-1'))).toBe(true);
    expect(setIgNoCredentials).toHaveBeenCalledWith('online-1', true);
    expect(setIgNoCredentials).toHaveBeenCalledWith('offline-1', true);
    expect(setActive).toHaveBeenCalledTimes(1);
    expect(setActive.mock.calls[0][0].instagramAccountId).toBeUndefined();
    expect(setActive.mock.calls[0][0].accessToken).toBeUndefined();
  });

  it('clears GMB hash fields and location review key without touching IG active tokens', async () => {
    const clearHashFields = mock(async () => {});
    const deleteKeys = mock(async () => {});
    const setActive = mock(async () => true);

    const deps: IntegrationDisconnectCacheDeps = {
      applySocialDisconnected: mock(async () => ({})),
      findDeviceClientIds: async () => ['d1'],
      getAllActive: async () => [device('d1', 'biz-1')],
      setActive,
      clearHashFields,
      deleteKeys,
      setIgNoCredentials: mock(() => {}),
      getGmbProfileId: () => 'loc-9'
    };

    await applyIntegrationDisconnectCache(
      { userId: 'biz-1', provider: Provider.GOOGLE_BUSINESS },
      deps
    );

    expect(clearHashFields.mock.calls[0][1]).toEqual([
      'gmb_accessToken',
      'gmb_profile_id',
      'gmb_review_count'
    ]);
    expect(deleteKeys.mock.calls[0][0]).toEqual(['gmb:reviews:loc-9']);
    expect(setActive).not.toHaveBeenCalled();
  });
});
