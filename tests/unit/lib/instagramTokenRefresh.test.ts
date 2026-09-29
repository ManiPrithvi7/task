const hSet = jest.fn();
const expire = jest.fn();
const setActive = jest.fn();
const updateOne = jest.fn();

jest.mock('@/lib/socials/integrations', () => ({
  isAccessTokenExpired: (record: { tokenExp: string; tokenCreatedAt: Date | null }) => {
    if (!record.tokenCreatedAt) return true;
    const expSeconds = Number.parseInt(record.tokenExp, 10);
    if (!Number.isFinite(expSeconds) || expSeconds <= 0) return true;
    return Date.now() >= record.tokenCreatedAt.getTime() + expSeconds * 1000;
  },
  ig: {
    refreshLongLivedToken: jest.fn()
  }
}));

jest.mock('@/models/Social', () => ({
  Social: {
    findOne: jest.fn(),
    updateOne: (...args: unknown[]) => updateOne(...args)
  },
  Provider: { INSTAGRAM: 'INSTAGRAM', GOOGLE_BUSINESS: 'GOOGLE_BUSINESS' }
}));

jest.mock('@/services/redisService', () => ({
  getRedisService: () => ({
    isRedisConnected: () => true,
    getClient: () => ({ hSet, expire })
  })
}));

jest.mock('@/services/deviceService', () => ({
  getActiveDeviceCache: () => ({
    getActive: async () => ({
      deviceId: '274968B43A1D',
      businessId: '507f1f77bcf86cd799439011',
      lastSeen: 1,
      accessToken: 'old-token'
    }),
    setActive: (...args: unknown[]) => setActive(...args)
  })
}));

import { ig } from '@/lib/socials/integrations';
import { ensureFreshInstagramAccessToken } from '@/lib/socials/instagramTokenRefresh';

const refreshLongLivedToken = ig.refreshLongLivedToken as jest.Mock;

const USER = '507f1f77bcf86cd799439011';
const SIXTY_DAYS_SEC = '5184000';

describe('ensureFreshInstagramAccessToken', () => {
  beforeEach(() => {
    refreshLongLivedToken.mockReset();
    hSet.mockReset();
    expire.mockReset();
    setActive.mockReset();
    updateOne.mockReset();
    hSet.mockResolvedValue(1);
    expire.mockResolvedValue(1);
    updateOne.mockResolvedValue({ modifiedCount: 0 });
    setActive.mockResolvedValue(true);
  });

  it('does not refresh when the cached token is still inside tokenExp', async () => {
    const token = await ensureFreshInstagramAccessToken({
      deviceId: '274968B43A1D',
      accessToken: 'still-valid',
      userId: USER,
      tokenExp: SIXTY_DAYS_SEC,
      tokenCreatedAt: new Date()
    });

    expect(token).toBe('still-valid');
    expect(refreshLongLivedToken).not.toHaveBeenCalled();
    expect(hSet).not.toHaveBeenCalled();
  });

  it('refreshes when tokenCreatedAt is older than tokenExp and stores both fields', async () => {
    refreshLongLivedToken.mockResolvedValue({ access_token: 'new-token', expires_in: 5184000 });
    const created = new Date(Date.now() - 61 * 24 * 3600 * 1000);

    const token = await ensureFreshInstagramAccessToken({
      deviceId: '274968B43A1D',
      accessToken: 'expired-token',
      userId: USER,
      tokenExp: SIXTY_DAYS_SEC,
      tokenCreatedAt: created
    });

    expect(token).toBe('new-token');
    expect(refreshLongLivedToken).toHaveBeenCalledWith('expired-token');
    expect(hSet).toHaveBeenCalledWith(
      'proof.mqtt:device:274968B43A1D',
      expect.objectContaining({
        ig_accessToken: 'new-token',
        ig_token_exp: '5184000',
        ig_token_created_at: expect.any(String)
      })
    );
    const written = hSet.mock.calls[0][1] as { ig_token_created_at: string };
    expect(Number(written.ig_token_created_at)).toBeGreaterThan(created.getTime());
  });
});
