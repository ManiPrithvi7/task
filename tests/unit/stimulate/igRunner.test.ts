/**
 * TEMP STIMULATE — remove after testing
 */
import { runIgTick, resolveLiveFollowersForStim } from '../../../stimulate/igRunner';
import { clearStimCache } from '../../../stimulate/cache';

const mockPublish = jest.fn().mockResolvedValue(undefined);

const mqttClient = {
  publish: mockPublish
} as unknown as Parameters<typeof runIgTick>[2];

const redis = {} as Parameters<typeof runIgTick>[5];

jest.mock('../../../src/services/redisService', () => ({
  getRedisService: () => null
}));

describe('resolveLiveFollowersForStim', () => {
  it('always returns synthetic live=0 (credentials ignored)', async () => {
    await expect(resolveLiveFollowersForStim('DEVICE-15')).resolves.toEqual({
      live: 0,
      mode: 'synthetic'
    });
  });
});

describe('runIgTick synthetic ramp', () => {
  const deviceId = 'DEVICE-STIM-IG-TEST';

  beforeEach(() => {
    mockPublish.mockClear();
    clearStimCache('instagram', deviceId);
  });

  it('publishes step count on first tick', async () => {
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

  it('stops publishing after done (no same-message spam)', async () => {
    clearStimCache('instagram', deviceId);
    const { writeStimCache } = await import('../../../stimulate/cache');
    writeStimCache('instagram', deviceId, { lastPublished: 500, status: 'done' });

    const result = await runIgTick(deviceId, 'proof.mqtt', mqttClient, 1, 500, redis);
    expect(result).toEqual({ done: true, publishedCount: 0 });
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
