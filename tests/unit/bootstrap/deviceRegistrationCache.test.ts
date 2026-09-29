const findOne = jest.fn();
const hGetAll = jest.fn();
const hSet = jest.fn();
const expire = jest.fn();

jest.mock('@/models/Device', () => ({
  Device: { findOne: (...args: unknown[]) => findOne(...args) }
}));

jest.mock('@/services/redisService', () => ({
  getRedisService: () => ({
    isRedisConnected: () => true,
    getClient: () => ({ hGetAll, hSet, expire })
  })
}));

import { cacheActiveDevice } from '@/bootstrap/deviceRegistrationHandler';

function host() {
  const setActive = jest.fn().mockResolvedValue(true);
  return {
    activeDeviceCache: { setActive, getActive: jest.fn() },
    loadLatestInstagramSocialForUser: jest.fn(),
    setActive
  };
}

describe('cacheActiveDevice', () => {
  beforeEach(() => {
    findOne.mockReset();
    hGetAll.mockReset();
    hSet.mockReset();
    expire.mockReset();
    hSet.mockResolvedValue(1);
    expire.mockResolvedValue(1);
  });

  it('uses the Redis device hash and skips Mongo when the hash exists', async () => {
    hGetAll.mockResolvedValue({
      business_id: '6a912cb61c0192e41bd2f62a',
      ig_accountId: '17841415149243143',
      ig_accessToken: 'token',
      status: 'active'
    });
    const h = host();

    await cacheActiveDevice(h as never, '274968B43A1D');

    expect(findOne).not.toHaveBeenCalled();
    expect(h.loadLatestInstagramSocialForUser).not.toHaveBeenCalled();
    expect(h.setActive).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: '274968B43A1D',
        businessId: '6a912cb61c0192e41bd2f62a',
        instagramAccountId: '17841415149243143',
        accessToken: 'token'
      })
    );
  });

  it('loads the device from Mongo when Redis has no hash', async () => {
    hGetAll.mockResolvedValue({});
    findOne.mockResolvedValue({
      clientId: 'NEWDEVICE',
      businessId: { toString: () => '507f1f77bcf86cd799439011' },
      status: 'ACTIVE',
      provisionedAt: new Date(1_700_000_000_000)
    });
    const h = host();
    h.loadLatestInstagramSocialForUser.mockResolvedValue(null);

    await cacheActiveDevice(h as never, 'NEWDEVICE');

    expect(findOne).toHaveBeenCalledWith({ clientId: 'NEWDEVICE' });
    expect(h.loadLatestInstagramSocialForUser).toHaveBeenCalledWith('507f1f77bcf86cd799439011');
    expect(h.setActive).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'NEWDEVICE',
        businessId: '507f1f77bcf86cd799439011'
      })
    );
  });
});
