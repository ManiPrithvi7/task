/**
 * TEMP STIMULATE — remove after testing
 */
import { runIgTick, resolveLiveFollowersForStim } from '../../../stimulate/igRunner';
import { clearStimCache } from '../../../stimulate/cache';
import { Device } from '../../../src/models/Device';
import { Social } from '../../../src/models/Social';
import { fetchInstagramProfileMetrics } from '../../../src/lib/socials/instagramMetrics';

const mockPublish = jest.fn().mockResolvedValue(undefined);

const mqttClient = {
  publish: mockPublish
} as unknown as Parameters<typeof runIgTick>[2];

const redis = {} as Parameters<typeof runIgTick>[5];

jest.mock('../../../src/models/Device', () => ({
  Device: { findOne: jest.fn() }
}));

jest.mock('../../../src/models/Social', () => ({
  Social: { findOne: jest.fn() },
  Provider: { INSTAGRAM: 'INSTAGRAM', GOOGLE_BUSINESS: 'GOOGLE_BUSINESS' }
}));

jest.mock('../../../src/lib/socials/instagramTokenRefresh', () => ({
  ensureFreshInstagramAccessToken: jest.fn(async ({ accessToken }: { accessToken: string }) => accessToken)
}));

jest.mock('../../../src/lib/socials/instagramMetrics', () => ({
  fetchInstagramProfileMetrics: jest.fn()
}));

jest.mock('../../../src/services/redisService', () => ({
  getRedisService: () => null
}));

const mockedDeviceFind = Device.findOne as jest.Mock;
const mockedSocialFind = Social.findOne as jest.Mock;
const mockedFetchMetrics = fetchInstagramProfileMetrics as jest.Mock;

function mongoLean<T>(value: T) {
  return {
    select: () => ({
      lean: async () => value
    })
  };
}

describe('resolveLiveFollowersForStim', () => {
  beforeEach(() => {
    mockedDeviceFind.mockReset();
    mockedSocialFind.mockReset();
    mockedFetchMetrics.mockReset();
  });

  it('returns synthetic live=0 when no Instagram connection', async () => {
    mockedDeviceFind.mockReturnValue(mongoLean(null));
    await expect(resolveLiveFollowersForStim('DEVICE-15')).resolves.toEqual({
      live: 0,
      mode: 'synthetic'
    });
  });

  it('returns skip when connected but API fetch fails', async () => {
    mockedDeviceFind.mockReturnValue(mongoLean({ userId: '507f1f77bcf86cd799439011' }));
    mockedSocialFind.mockReturnValue(
      mongoLean({
        socialAccountId: 'ig-1',
        accessToken: 'tok',
        tokenExp: null,
        tokenCreatedAt: null
      })
    );
    mockedFetchMetrics.mockResolvedValue(null);

    await expect(resolveLiveFollowersForStim('DEVICE-15')).resolves.toEqual({ skip: true });
  });

  it('returns live count when connected', async () => {
    mockedDeviceFind.mockReturnValue(mongoLean({ userId: '507f1f77bcf86cd799439011' }));
    mockedSocialFind.mockReturnValue(
      mongoLean({
        socialAccountId: 'ig-1',
        accessToken: 'tok',
        tokenExp: null,
        tokenCreatedAt: null
      })
    );
    mockedFetchMetrics.mockResolvedValue({ metrics: { followers_count: 42 } });

    await expect(resolveLiveFollowersForStim('DEVICE-15')).resolves.toEqual({
      live: 42,
      mode: 'live'
    });
  });
});

describe('runIgTick synthetic ramp', () => {
  const deviceId = 'DEVICE-STIM-IG-TEST';

  beforeEach(() => {
    mockPublish.mockClear();
    mockedDeviceFind.mockReset();
    mockedSocialFind.mockReset();
    mockedFetchMetrics.mockReset();
    mockedDeviceFind.mockReturnValue(mongoLean(null));
    clearStimCache('instagram', deviceId);
  });

  it('publishes step count on first tick when no IG connection', async () => {
    const result = await runIgTick(deviceId, 'proof.mqtt', mqttClient, 1, 500, redis);

    expect(result).toEqual({ done: false, publishedCount: 1 });
    expect(mockPublish).toHaveBeenCalledTimes(1);
    const call = mockPublish.mock.calls[0][0] as { topic: string; payload: string };
    expect(call.topic).toBe(`proof.mqtt/${deviceId}/instagram`);
    const envelope = JSON.parse(call.payload);
    expect(envelope.version).toBe('1.2');
    expect(envelope.screen).toBe('instagram');
    expect(envelope.payload.followers).toBe(1);
  });

  it('does not publish when connected but API fetch fails', async () => {
    mockedDeviceFind.mockReturnValue(mongoLean({ userId: '507f1f77bcf86cd799439011' }));
    mockedSocialFind.mockReturnValue(
      mongoLean({
        socialAccountId: 'ig-1',
        accessToken: 'tok',
        tokenExp: null,
        tokenCreatedAt: null
      })
    );
    mockedFetchMetrics.mockResolvedValue(null);

    const result = await runIgTick(deviceId, 'proof.mqtt', mqttClient, 1, 500, redis);

    expect(result).toEqual({ done: false, publishedCount: 0 });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('synthetic ramp hits mini celebration at 25', async () => {
    for (let i = 0; i < 24; i++) {
      await runIgTick(deviceId, 'proof.mqtt', mqttClient, 1, 500, redis);
    }
    mockPublish.mockClear();

    await runIgTick(deviceId, 'proof.mqtt', mqttClient, 1, 500, redis);

    const call = mockPublish.mock.calls[0][0] as { payload: string };
    const envelope = JSON.parse(call.payload);
    expect(envelope.celebration).toBe('true');
    expect(envelope.payload.celebration_type).toBe('mini');
    expect(envelope.payload.followers).toBe(25);
    expect(envelope.payload.progress).toBe(100);
  });
});
