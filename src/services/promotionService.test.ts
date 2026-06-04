import {
  buildPromotionPayload,
  getNextPromotionIndex,
  getPromotionCacheTtlSec
} from './promotionService';

jest.mock('../models/Ad', () => ({
  Ad: { find: jest.fn() },
  AdStatus: { RUNNING: 'RUNNING' },
  AdType: { PROMOTION: 'PROMOTION' }
}));
jest.mock('./redisService', () => ({
  getRedisService: jest.fn()
}));
jest.mock('./deviceService', () => ({
  getActiveDeviceCache: jest.fn()
}));

import { getRedisService } from './redisService';

const mockGetRedis = getRedisService as jest.MockedFunction<typeof getRedisService>;

describe('promotionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRedis.mockReturnValue(null);
  });

  it('buildPromotionPayload maps template fields and campaign claim URL', () => {
    const payload = buildPromotionPayload(
      {
        provider: 'square',
        Offer: '15%',
        message: 'Latte',
        qrText: 'https://custom.qr'
      },
      'camp123'
    );
    expect(payload).toEqual({
      platform: 'square',
      Offer: '15%',
      message: 'Latte',
      qrText: 'https://custom.qr'
    });
  });

  it('buildPromotionPayload falls back to claim URL when qrText missing', () => {
    const payload = buildPromotionPayload({ offer: '10%', textContent: 'Tea' }, 'abc');
    expect(payload.qrText).toBe('https://statsnapp.vercel.app/claim/abc');
    expect(payload.message).toBe('Tea');
  });

  it('getNextPromotionIndex returns 0 when Redis unavailable', async () => {
    const index = await getNextPromotionIndex('dev-1', 3);
    expect(index).toBe(0);
  });

  it('getNextPromotionIndex advances round-robin in Redis', async () => {
    const store = new Map<string, string>();
    mockGetRedis.mockReturnValue({
      isRedisConnected: () => true,
      getClient: () => ({
        get: (k: string) => Promise.resolve(store.get(k) ?? null),
        set: (k: string, v: string) => {
          store.set(k, v);
          return Promise.resolve('OK');
        },
        del: jest.fn()
      })
    } as never);

    expect(await getNextPromotionIndex('dev-1', 3)).toBe(0);
    expect(await getNextPromotionIndex('dev-1', 3)).toBe(1);
    expect(await getNextPromotionIndex('dev-1', 3)).toBe(2);
    expect(await getNextPromotionIndex('dev-1', 3)).toBe(0);
  });

  it('getPromotionCacheTtlSec defaults to 3600', () => {
    expect(getPromotionCacheTtlSec()).toBe(3600);
  });
});
