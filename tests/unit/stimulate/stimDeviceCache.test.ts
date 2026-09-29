import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { REDIS_KEYS } from '../../../src/constants/redisKeys';
import {
  isStimPollutedIgCount,
  isStimPollutedGmbCount
} from '../../../src/services/igDeviceRuntimeCache';

describe('REDIS_KEYS stim namespace', () => {
  it('uses proof.mqtt:stim:device:{id} separate from device hash', () => {
    expect(REDIS_KEYS.stimDeviceHash('274968B43A1D')).toBe('proof.mqtt:stim:device:274968B43A1D');
    expect(REDIS_KEYS.deviceHash('274968B43A1D')).toBe('proof.mqtt:device:274968B43A1D');
    expect(REDIS_KEYS.stimActiveDevices).toBe('proof.mqtt:stim:active_devices');
  });
});

describe('isStimPollutedIgCount', () => {
  it('flags explicit stim origin', () => {
    expect(
      isStimPollutedIgCount({ ig_follower_count: '1139', ig_followers_origin: 'stim' })
    ).toBe(true);
  });

  it('keeps social origin', () => {
    expect(
      isStimPollutedIgCount({
        ig_follower_count: '100',
        ig_followers_origin: 'social',
        ig_accountId: 'x',
        ig_accessToken: 'y'
      })
    ).toBe(false);
  });

  it('flags missing origin without credentials (legacy pollution)', () => {
    expect(isStimPollutedIgCount({ ig_follower_count: '1139' })).toBe(true);
  });

  it('keeps missing origin when credentials present', () => {
    expect(
      isStimPollutedIgCount({
        ig_follower_count: '50',
        ig_accountId: 'acct',
        ig_accessToken: 'tok'
      })
    ).toBe(false);
  });
});

describe('isStimPollutedGmbCount', () => {
  it('flags stim origin', () => {
    expect(isStimPollutedGmbCount({ gmb_review_count: '9', gmb_reviews_origin: 'stim' })).toBe(true);
  });

  it('keeps webhook origin', () => {
    expect(
      isStimPollutedGmbCount({
        gmb_review_count: '9',
        gmb_reviews_origin: 'webhook',
        gmb_profile_id: 'p',
        gmb_accessToken: 't'
      })
    ).toBe(false);
  });
});

describe('stimDeviceCache memory API', () => {
  beforeEach(() => {
    mock.module('../../../src/services/redisService', () => ({
      getRedisService: () => null
    }));
  });

  afterEach(async () => {
    const stim = await import('../../../stimulate/stimDeviceCache');
    stim._resetForTests();
  });

  it('set/get round-trip in memory with stim origin', async () => {
    const stim = await import('../../../stimulate/stimDeviceCache');
    stim._resetForTests();
    await stim.set('DEV1', { igFollowerCount: 42, igFollowersOrigin: 'stim' });
    expect(stim.getFollowers('DEV1')).toBe(42);
    expect(stim.get('DEV1')?.igFollowersOrigin).toBe('stim');
    await stim.del('DEV1');
    expect(stim.getFollowers('DEV1')).toBeUndefined();
  });
});
