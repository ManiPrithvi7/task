import {
  publishHashRedisKey,
  clearPublishHash,
  clearAllPublishHashesForDevice
} from '@/services/mqttChangeDetection';
import {
  getLocalPublishHashCache,
  resetLocalCachesForTests
} from '@/services/localCaches';

describe('mqttChangeDetection hash keys', () => {
  beforeEach(() => {
    resetLocalCachesForTests();
  });

  it('publishHashRedisKey matches publishIfChanged format', () => {
    expect(publishHashRedisKey('DEVICE-19', 'proof.mqtt/DEVICE-19/promotion')).toBe(
      'msg:last_hash:DEVICE-19:proof.mqtt/DEVICE-19/promotion'
    );
  });

  it('clearPublishHash deletes the local hash entry', async () => {
    getLocalPublishHashCache().set(
      'DEVICE-1',
      'proof.mqtt/DEVICE-1/promotion',
      'abc',
      86400_000
    );

    const ok = await clearPublishHash('DEVICE-1', 'proof.mqtt/DEVICE-1/promotion');
    expect(ok).toBe(true);
    expect(
      getLocalPublishHashCache().get('DEVICE-1', 'proof.mqtt/DEVICE-1/promotion')
    ).toBeNull();
  });

  it('clearAllPublishHashesForDevice clears all topics for device', async () => {
    const cache = getLocalPublishHashCache();
    cache.set('DEVICE-1', 'proof.mqtt/DEVICE-1/promotion', 'a', 86400_000);
    cache.set('DEVICE-1', 'proof.mqtt/DEVICE-1/gmb', 'b', 86400_000);
    cache.set('DEVICE-2', 'proof.mqtt/DEVICE-2/promotion', 'c', 86400_000);

    const count = await clearAllPublishHashesForDevice('DEVICE-1');
    expect(count).toBe(2);
    expect(cache.get('DEVICE-1', 'proof.mqtt/DEVICE-1/promotion')).toBeNull();
    expect(cache.get('DEVICE-2', 'proof.mqtt/DEVICE-2/promotion')).toBe('c');
  });
});
