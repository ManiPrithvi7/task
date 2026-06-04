import { isCampaignActive } from '@/services/campaignSchedule';
import { CampaignStatus, ScheduleType, DiscountType, TargetType } from '@/models/Campaign';
import { Provider } from '@/models/Social';
import type { ICampaign } from '@/models/Campaign';

function baseCampaign(overrides: Partial<ICampaign> = {}): ICampaign {
  return {
    _id: { toString: () => 'c1' } as ICampaign['_id'],
    userId: { toString: () => 'u1' } as ICampaign['userId'],
    name: 'Test',
    offerCode: 'CODE1',
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

describe('isCampaignActive', () => {
  it('returns false when status is not ACTIVE', () => {
    expect(isCampaignActive(baseCampaign({ status: CampaignStatus.PAUSED }))).toBe(false);
  });

  it('returns false before startsAt', () => {
    const future = new Date(Date.now() + 86400000);
    expect(isCampaignActive(baseCampaign({ startsAt: future }), new Date())).toBe(false);
  });

  it('returns true for ALWAYS schedule', () => {
    expect(isCampaignActive(baseCampaign())).toBe(true);
  });

  it('returns true for DAY_OF_WEEK when day matches', () => {
    const now = new Date('2026-06-04T12:00:00Z'); // Thursday UTC
    const campaign = baseCampaign({
      scheduleType: ScheduleType.DAY_OF_WEEK,
      scheduleConfig: { days: [4], timezone: 'UTC' }
    });
    expect(isCampaignActive(campaign, now)).toBe(true);
  });
});
