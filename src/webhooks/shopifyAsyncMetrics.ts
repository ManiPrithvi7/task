import { Provider } from '../models/Social';
import { processDailyMetrics } from '../services/metrics/processDailyMetrics';
import { incrementCampaignUsage } from '../services/metrics/incrementCampaignUsage';
import { logger } from '../utils/logger';

const getIdString = (value: unknown): string | null => {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  return null;
};

export function scheduleShopifyAsyncMetrics(
  userId: string,
  topic: string,
  rawBody: string,
  enableDailyMetrics: boolean
): void {
  if (topic !== 'orders/paid' || !enableDailyMetrics) return;

  setImmediate(() => {
    void runShopifyAsyncMetrics(userId, rawBody).catch((err) => {
      logger.error('[SHOPIFY_ASYNC] Metrics failed', {
        userId,
        error: err instanceof Error ? err.message : String(err)
      });
    });
  });
}

async function runShopifyAsyncMetrics(userId: string, rawBody: string): Promise<void> {
  const body = JSON.parse(rawBody) as Record<string, unknown>;

  const financialStatus =
    typeof body.financial_status === 'string' ? body.financial_status : null;
  if (financialStatus !== 'paid') return;

  const checkoutId =
    getIdString(body.checkout_id) || getIdString(body.id) || '';
  const dedupeKey = checkoutId.trim();
  if (!dedupeKey) return;

  const totalPrice =
    typeof body.current_total_price === 'string'
      ? body.current_total_price
      : typeof body.total_price === 'string'
        ? body.total_price
        : null;

  const discountAmount =
    typeof body.current_total_discounts === 'string'
      ? body.current_total_discounts
      : typeof body.total_discounts === 'string'
        ? body.total_discounts
        : '0';

  const paidAt =
    (typeof body.processed_at === 'string' ? body.processed_at : null) ||
    (typeof body.updated_at === 'string' ? body.updated_at : null) ||
    (typeof body.created_at === 'string' ? body.created_at : null);

  if (!totalPrice || !paidAt) return;

  await processDailyMetrics({
    userId,
    checkoutId: dedupeKey,
    totalPrice,
    paidAt,
    hasDiscount: Array.isArray(body.discount_codes) && body.discount_codes.length > 0
  });

  const discountCodes = Array.isArray(body.discount_codes)
    ? (body.discount_codes as Array<Record<string, unknown>>)
        .map((d) => (typeof d.code === 'string' ? d.code : null))
        .filter((c): c is string => !!c && c.trim().length > 0)
    : [];

  if (discountCodes.length === 0) return;

  for (const discountCode of discountCodes) {
    await incrementCampaignUsage({
      userId,
      discountCode,
      totalPrice,
      discountAmount,
      platform: Provider.SHOPIFY,
      checkoutId: dedupeKey,
      paidAt
    });
  }
}
