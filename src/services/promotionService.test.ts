import {
  buildCampaignPayload,
  buildPromotionPayload,
  getNextPromotionIndex,
  getPromotionCacheTtlSec
} from './promotionService';
import { DiscountType } from '../models/Campaign';
import { Provider } from '../models/Social';

jest.mock('../models/Ad', () => ({
  Ad: { findOne: jest.fn() },
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
    delete process.env.CLAIM_BASE_URL;
  });

  it('buildCampaignPayload formats percentage offer', () => {
    const payload = buildCampaignPayload({
      _id: 'c1',
      name: 'Summer Sale',
      offerCode: 'SUMMER20',
      platform: Provider.SHOPIFY,
      discountType: DiscountType.PERCENTAGE,
      discountValue: 20,
      description: 'Iced drinks'
    });
    expect(payload.Offer).toBe('20%');
    expect(payload.message).toBe('Iced drinks');
    expect(payload.qrText).toBe('https://statsnapp.vercel.app/claim/SUMMER20');
  });

  it('buildCampaignPayload formats fixed amount offer', () => {
    const payload = buildCampaignPayload({
      _id: 'c2',
      name: 'Five off',
      offerCode: 'FIVE',
      platform: Provider.SQUARE,
      discountType: DiscountType.FIXED_AMOUNT,
      discountValue: 5
    });
    expect(payload.Offer).toBe('$5');
    expect(payload.platform).toBe('square');
  });

  it('buildPromotionPayload still supports Ad template override path', () => {
    const payload = buildPromotionPayload({ offer: '10%', textContent: 'Tea' }, 'abc');
    expect(payload.qrText).toBe('https://statsnapp.vercel.app/claim/abc');
    expect(payload.message).toBe('Tea');
  });

  it('getNextPromotionIndex returns 0 when Redis unavailable', async () => {
    expect(await getNextPromotionIndex('dev-1', 3)).toBe(0);
  });

  it('getPromotionCacheTtlSec defaults to 3600', () => {
    expect(getPromotionCacheTtlSec()).toBe(3600);
  });
});
