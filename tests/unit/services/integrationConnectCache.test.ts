import { describe, expect, it, mock } from 'bun:test';
import { Provider } from '../../../src/models/Social';
import { applyIntegrationConnectCache } from '../../../src/services/integrationConnectCache';
import type { ActiveDevice } from '../../../src/services/deviceService';
import type { IntegrationConnectCacheDeps } from '../../../src/services/integrationConnectCache';

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
