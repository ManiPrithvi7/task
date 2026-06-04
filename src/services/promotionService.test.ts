import {
  buildCampaignPayload,
  filterSchedulableCampaigns,
  getNextPromotionIndex,
  getPromotionCacheTtlSec,
  type CachedCampaignDto
} from './promotionService';
import { CampaignStatus, DiscountType, ScheduleType, TargetType } from '../models/Campaign';
import { Provider } from '../models/Social';
import type { ICampaign } from '../models/Campaign';

jest.mock('./redisService', () => ({
  getRedisService: jest.fn()
}));
jest.mock('./deviceService', () => ({
  getActiveDeviceCache: jest.fn()
}));

import { getRedisService } from './redisService';

const mockGetRedis = getRedisService as jest.MockedFunction<typeof getRedisService>;

function baseCampaign(overrides: Partial<ICampaign> = {}): ICampaign {
  return {
    _id: { toString: () => 'c1' } as ICampaign['_id'],
    userId: { toString: () => 'u1' } as ICampaign['userId'],
    name: 'Summer Sale',
    offerCode: 'SUMMAR26',
    discountType: DiscountType.PERCENTAGE,
    discountValue: 10,
    targetType: TargetType.ALL,
    scheduleType: ScheduleType.ALWAYS,
    status: CampaignStatus.ACTIVE,
    platform: Provider.SHOPIFY,
    nfcCount: 0,
    scanCount: 0,
    redemptionCount: 0,
    redemptionRevenueCents: 0,
    ...overrides
  } as ICampaign;
}

function baseCachedDto(overrides: Partial<CachedCampaignDto> = {}): CachedCampaignDto {
  return {
    _id: 'c1',
    name: 'Summer Sale',
    offerCode: 'SUMMAR26',
    platform: Provider.SHOPIFY,
    discountType: DiscountType.PERCENTAGE,
    discountValue: 10,
    status: CampaignStatus.ACTIVE,
    scheduleType: ScheduleType.ALWAYS,
    ...overrides
  };
}

describe('promotionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRedis.mockReturnValue(null);
    delete process.env.CLAIM_BASE_URL;
  });

  it('buildCampaignPayload formats percentage offer from campaign', () => {
    const payload = buildCampaignPayload({
      _id: 'c1',
      name: 'Summer Sale',
      offerCode: 'SUMMER20',
      platform: Provider.SHOPIFY,
      discountType: DiscountType.PERCENTAGE,
      discountValue: 20,
      description: 'Iced drinks',
      status: CampaignStatus.ACTIVE,
      scheduleType: ScheduleType.ALWAYS
    });
    expect(payload.Offer).toBe('20%');
    expect(payload.message).toBe('Iced drinks');
    expect(payload.qrText).toBe('https://statsnapp.vercel.app/claim/SUMMER20');
  });

  it('buildCampaignPayload uses offerCode in qrText', () => {
    const payload = buildCampaignPayload(baseCampaign());
    expect(payload.Offer).toBe('10%');
    expect(payload.qrText).toBe('https://statsnapp.vercel.app/claim/SUMMAR26');
  });

  it('buildCampaignPayload empty message when no description or name', () => {
    const payload = buildCampaignPayload({
      _id: 'c1',
      name: '',
      offerCode: 'CODE',
      platform: Provider.SHOPIFY,
      discountType: DiscountType.PERCENTAGE,
      discountValue: 10,
      status: CampaignStatus.ACTIVE,
      scheduleType: ScheduleType.ALWAYS
    });
    expect(payload.message).toBe('');
  });

  it('buildCampaignPayload formats fixed amount offer', () => {
    const payload = buildCampaignPayload({
      _id: 'c2',
      name: 'Five off',
      offerCode: 'FIVE',
      platform: Provider.SQUARE,
      discountType: DiscountType.FIXED_AMOUNT,
      discountValue: 5,
      status: CampaignStatus.ACTIVE,
      scheduleType: ScheduleType.ALWAYS
    });
    expect(payload.Offer).toBe('$5');
    expect(payload.platform).toBe('square');
  });

  it('filterSchedulableCampaigns excludes PAUSED', () => {
    const campaigns = [
      baseCampaign(),
      baseCampaign({ status: CampaignStatus.PAUSED, name: 'Paused' })
    ];
    expect(filterSchedulableCampaigns(campaigns)).toHaveLength(1);
    expect(filterSchedulableCampaigns(campaigns)[0].name).toBe('Summer Sale');
  });

  it('filterSchedulableCampaigns excludes before startsAt', () => {
    const future = new Date(Date.now() + 86400000);
    const campaigns = [baseCampaign({ startsAt: future })];
    expect(filterSchedulableCampaigns(campaigns, new Date())).toHaveLength(0);
  });

  it('filterSchedulableCampaigns includes ALWAYS schedule', () => {
    expect(filterSchedulableCampaigns([baseCampaign()])).toHaveLength(1);
  });

  it('filterSchedulableCampaigns re-checks cached DTO time windows', () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const dto = baseCachedDto({ startsAt: future });
    expect(filterSchedulableCampaigns([dto], new Date())).toHaveLength(0);
  });

  it('getNextPromotionIndex returns 0 when Redis unavailable', async () => {
    expect(await getNextPromotionIndex('dev-1', 3)).toBe(0);
  });

  it('getPromotionCacheTtlSec defaults to 3600', () => {
    expect(getPromotionCacheTtlSec()).toBe(3600);
  });
});
