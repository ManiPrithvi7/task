/**
 * TEMP STIMULATE — remove after testing
 */
import { runGmbTick } from '../../../stimulate/gmbRunner';
import { clearStimCache, writeStimCache } from '../../../stimulate/cache';
import * as stimDeviceCache from '../../../stimulate/stimDeviceCache';

const mockPublishGmbScreen = jest.fn().mockResolvedValue({
  topic: 'proof.mqtt/DEVICE-STIM-GMB-TEST/gmb',
  published: true,
  payload: '{}',
  success: true
});

jest.mock('../../../src/webhooks/delivery/publishGmbScreen', () => ({
  publishGmbScreen: (...args: unknown[]) => mockPublishGmbScreen(...args)
}));

jest.mock('../../../src/services/redisService', () => ({
  getRedisService: () => null
}));

const mqttClient = {} as Parameters<typeof runGmbTick>[2];
const redis = {} as Parameters<typeof runGmbTick>[6];

describe('runGmbTick synthetic ramp', () => {
  const deviceId = 'DEVICE-STIM-GMB-TEST';

  beforeEach(async () => {
    mockPublishGmbScreen.mockClear();
    clearStimCache('gmb', deviceId);
    stimDeviceCache._resetForTests();
    await stimDeviceCache.del(deviceId);
  });

  it('resumes from stim device cache after empty in-memory cursor', async () => {
    await stimDeviceCache.set(deviceId, { gmbReviewCount: 33, gmbReviewsOrigin: 'stim' });

    const result = await runGmbTick(deviceId, 'proof.mqtt', mqttClient, true, 1, 100, redis);

    expect(result).toEqual({ done: false, publishedCount: 1 });
    expect(mockPublishGmbScreen).toHaveBeenCalledWith(
      mqttClient,
      'proof.mqtt',
      deviceId,
      { verifiedReview: 34, rating: 4 },
      true
    );
  });

  it('writes reviews to stim cache only (not real runtime path)', async () => {
    const { getIgDeviceRuntimeCache } = await import('../../../src/services/igDeviceRuntimeCache');
    getIgDeviceRuntimeCache().delete(deviceId);

    await runGmbTick(deviceId, 'proof.mqtt', mqttClient, true, 1, 100, redis);

    expect(stimDeviceCache.getGmbReviewCount(deviceId)).toBe(1);
    expect(getIgDeviceRuntimeCache().getGmbReviewCount(deviceId)).toBeUndefined();
  });

  it('publishes step count regardless of GMB credentials', async () => {
    const result = await runGmbTick(deviceId, 'proof.mqtt', mqttClient, true, 1, 100, redis);

    expect(result).toEqual({ done: false, publishedCount: 1 });
    expect(mockPublishGmbScreen).toHaveBeenCalledWith(
      mqttClient,
      'proof.mqtt',
      deviceId,
      { verifiedReview: 1, rating: 4 },
      true
    );
  });

  it('does not republish when already done', async () => {
    writeStimCache('gmb', deviceId, { lastPublished: 100, status: 'done' });

    const result = await runGmbTick(deviceId, 'proof.mqtt', mqttClient, true, 1, 100, redis);
    expect(result).toEqual({ done: true, publishedCount: 0 });
    expect(mockPublishGmbScreen).not.toHaveBeenCalled();
  });

  it('synthetic ramp hits mini celebration at 15', async () => {
    for (let i = 0; i < 14; i++) {
      await runGmbTick(deviceId, 'proof.mqtt', mqttClient, true, 1, 100, redis);
    }
    mockPublishGmbScreen.mockClear();

    await runGmbTick(deviceId, 'proof.mqtt', mqttClient, true, 1, 100, redis);

    expect(mockPublishGmbScreen).toHaveBeenCalledWith(
      mqttClient,
      'proof.mqtt',
      deviceId,
      { verifiedReview: 15, rating: 4 },
      true
    );
  });
});
