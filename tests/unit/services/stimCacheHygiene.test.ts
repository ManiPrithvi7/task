import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { getIgDeviceRuntimeCache } from '../../../src/services/igDeviceRuntimeCache';
import * as stimDeviceCache from '../../../stimulate/stimDeviceCache';

describe('stim pollution hygiene helpers', () => {
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

  it('runStimCacheStartupHygiene strips stim-polluted runtime followers when env unset', async () => {
    mock.module('../../../src/services/redisService', () => ({
      getRedisService: () => null
    }));
    mock.module('../../../src/services/deviceService', () => ({
      getActiveDeviceCache: () => ({
        getAllActive: async () => [{ deviceId, businessId: 'b1', lastSeen: Date.now() }]
      })
    }));

    const runtime = getIgDeviceRuntimeCache();
    runtime.setFollowers(deviceId, 1139, Date.now(), 'stim');

    const { runStimCacheStartupHygiene } = await import('../../../src/services/stimCacheHygiene');
    const result = await runStimCacheStartupHygiene();

    expect(result.strippedIg).toBe(1);
    expect(runtime.getFollowers(deviceId)).toBeUndefined();
    expect(runtime.getIgFollowersOrigin(deviceId)).toBeUndefined();
  });

  it('does not strip when device is currently stimulated', async () => {
    process.env.STIMULATE_DEVICE = deviceId;
    mock.module('../../../src/services/redisService', () => ({
      getRedisService: () => null
    }));
    mock.module('../../../src/services/deviceService', () => ({
      getActiveDeviceCache: () => ({
        getAllActive: async () => [{ deviceId, businessId: 'b1', lastSeen: Date.now() }]
      })
    }));

    const runtime = getIgDeviceRuntimeCache();
    runtime.setFollowers(deviceId, 1139, Date.now(), 'stim');

    const { runStimCacheStartupHygiene } = await import('../../../src/services/stimCacheHygiene');
    const result = await runStimCacheStartupHygiene();

    expect(result.strippedIg).toBe(0);
    expect(runtime.getFollowers(deviceId)).toBe(1139);
  });
});
