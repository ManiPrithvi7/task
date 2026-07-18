/**
 * TEMP STIMULATE — remove after testing
 */
import { runGmbTick } from '../../../stimulate/gmbRunner';
import { clearStimCache } from '../../../stimulate/cache';

const mockPublishGmbScreen = jest.fn().mockResolvedValue({
  topic: 'proof.mqtt/DEVICE-STIM-GMB-TEST/gmb',
  published: true,
  payload: '{}',
  success: true
});

jest.mock('../../../src/webhooks/delivery/publishGmbScreen', () => ({
  publishGmbScreen: (...args: unknown[]) => mockPublishGmbScreen(...args)
}));

jest.mock('../../../src/lib/socials/resolveDeviceGmb', () => ({
  resolveGmbContextForDevice: jest.fn()
}));

jest.mock('../../../src/services/redisService', () => ({
  getRedisService: () => null
}));

import { resolveGmbContextForDevice } from '../../../src/lib/socials/resolveDeviceGmb';

const mockedResolveGmb = resolveGmbContextForDevice as jest.MockedFunction<typeof resolveGmbContextForDevice>;

const mqttClient = {} as Parameters<typeof runGmbTick>[2];
const redis = {} as Parameters<typeof runGmbTick>[6];

describe('runGmbTick synthetic ramp', () => {
  const deviceId = 'DEVICE-STIM-GMB-TEST';

  beforeEach(() => {
    mockPublishGmbScreen.mockClear();
    mockedResolveGmb.mockReset();
    clearStimCache('gmb', deviceId);
  });

  it('publishes step count when no GMB connection', async () => {
    mockedResolveGmb.mockResolvedValue(null);

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

  it('uses live context when GMB is connected', async () => {
    mockedResolveGmb.mockResolvedValue({
      userId: 'user-1',
      deviceId,
      verifiedReviewCount: 10,
      averageRating: 4.5
    });

    const result = await runGmbTick(deviceId, 'proof.mqtt', mqttClient, true, 1, 100, redis);

    expect(result.publishedCount).toBe(1);
    expect(mockPublishGmbScreen).toHaveBeenCalledWith(
      mqttClient,
      'proof.mqtt',
      deviceId,
      { verifiedReview: 10, rating: 4.5 },
      true
    );
  });

  it('synthetic ramp hits mini celebration at 15', async () => {
    mockedResolveGmb.mockResolvedValue(null);

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
