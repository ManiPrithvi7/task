import mongoose from 'mongoose';
import { getRedisService } from '../redisService';
import { Campaign, CampaignStatus } from '../../models/Campaign';
import { Redemption } from '../../models/Redemption';
import { Provider } from '../../models/Social';
import { logger } from '../../utils/logger';

const DEDUPE_TTL_SECONDS = 7 * 24 * 60 * 60;

const toCents = (amount: string): number => {
  const numeric = Number.parseFloat(amount);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * 100);
};

export async function incrementCampaignUsage(params: {
  userId: string;
  discountCode: string;
  discountAmount: string;
  totalPrice: string;
  checkoutId: string;
  paidAt: string;
  platform: Provider;
}): Promise<void> {
  const discountCode = params.discountCode.trim();
  const checkoutId = params.checkoutId.trim();
  if (!discountCode || !checkoutId) return;

  const redis = getRedisService();
  if (redis?.isRedisConnected()) {
    const dedupeKey = `campaign_usage:${params.userId}:${checkoutId}:${discountCode}`;
    try {
      const setResult = await redis.getClient().set(dedupeKey, '1', { NX: true, EX: DEDUPE_TTL_SECONDS });
      if (setResult === null) return;
    } catch (err) {
      logger.warn('[CAMPAIGN_METRICS] Redis dedupe failed', {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  try {
    const now = new Date(params.paidAt);
    const userOid = new mongoose.Types.ObjectId(params.userId);

    const campaign = await Campaign.findOne({
      userId: userOid,
      platform: params.platform,
      offerCode: discountCode,
      status: CampaignStatus.ACTIVE,
      $and: [
        { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
        { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] }
      ]
    })
      .select({ _id: 1 })
      .lean();

    if (!campaign) return;

    await Redemption.findOneAndUpdate(
      { campaignId: campaign._id, orderId: checkoutId },
      {
        $setOnInsert: {
          campaignId: campaign._id,
          offerCode: discountCode,
          platform: params.platform,
          orderId: checkoutId,
          orderAmountCents: toCents(params.totalPrice),
          discountAmountCents: toCents(params.discountAmount),
          redeemedAt: now
        }
      },
      { upsert: true }
    );

    logger.debug('[CAMPAIGN_METRICS] Redemption recorded', {
      userId: params.userId,
      discountCode,
      checkoutId
    });
  } catch (err) {
    logger.error('[CAMPAIGN_METRICS] Failed', {
      userId: params.userId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
