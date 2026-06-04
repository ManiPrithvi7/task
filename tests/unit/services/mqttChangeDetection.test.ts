import {
  publishHashRedisKey,
  clearPublishHash,
  clearAllPublishHashesForDevice
} from '@/services/mqttChangeDetection';

jest.mock('@/services/redisService', () => ({
  getRedisService: jest.fn()
}));

import { getRedisService } from '@/services/redisService';

describe('mqttChangeDetection hash keys', () => {
  it('publishHashRedisKey matches publishIfChanged format', () => {
    expect(publishHashRedisKey('DEVICE-19', 'proof.mqtt/DEVICE-19/promotion')).toBe(
      'msg:last_hash:DEVICE-19:proof.mqtt/DEVICE-19/promotion'
    );
  });

  it('clearPublishHash deletes the key when Redis is connected', async () => {
    const del = jest.fn().mockResolvedValue(1);
    (getRedisService as jest.Mock).mockReturnValue({
      isRedisConnected: () => true,
      getClient: () => ({ del })
    });

    const ok = await clearPublishHash('DEVICE-1', 'proof.mqtt/DEVICE-1/promotion');
    expect(ok).toBe(true);
    expect(del).toHaveBeenCalledWith('msg:last_hash:DEVICE-1:proof.mqtt/DEVICE-1/promotion');
  });

  it('clearAllPublishHashesForDevice scans and deletes matching keys', async () => {
    const del = jest.fn().mockResolvedValue(2);
    const scan = jest
      .fn()
      .mockResolvedValueOnce({
        cursor: 0,
        keys: ['msg:last_hash:DEVICE-1:proof.mqtt/DEVICE-1/promotion', 'msg:last_hash:DEVICE-1:proof.mqtt/DEVICE-1/gmb']
      });
    (getRedisService as jest.Mock).mockReturnValue({
      isRedisConnected: () => true,
      getClient: () => ({ scan, del })
    });

    const count = await clearAllPublishHashesForDevice('DEVICE-1');
    expect(count).toBe(2);
    expect(scan).toHaveBeenCalledWith(0, { MATCH: 'msg:last_hash:DEVICE-1:*', COUNT: 100 });
  });
});
