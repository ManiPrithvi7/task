import { Provider } from '../models/Social';
import { getIdString, parseSquareWebhookEnvelope } from '../lib/socials/integrations';
import { processDailyMetrics } from '../services/metrics/processDailyMetrics';
import { incrementCampaignUsage } from '../services/metrics/incrementCampaignUsage';
import { extractSquareDiscountCodes, squareDiscountAmountCents } from './squareDiscountUtils';
import { logger } from '../utils/logger';

export function scheduleSquareAsyncMetrics(
  userId: string,
  eventType: string,
  rawBody: string,
  enableDailyMetrics: boolean
): void {
  if (!enableDailyMetrics) return;
  if (eventType !== 'payment.created' && eventType !== 'payment.updated') return;

  setImmediate(() => {
    void runSquareAsyncMetrics(userId, rawBody).catch((err) => {
      logger.error('[SQUARE_ASYNC] Metrics failed', {
        userId,
        error: err instanceof Error ? err.message : String(err)
      });
    });
  });
}

export async function runSquareAsyncMetrics(userId: string, rawBody: string): Promise<void> {
  const envelope = parseSquareWebhookEnvelope(rawBody);
  if (!envelope) return;

  const payment = envelope.data?.object?.payment as Record<string, unknown> | undefined;
  if (!payment) return;

  const checkoutId = getIdString(payment.order_id) || getIdString(payment.id) || '';
  if (!checkoutId.trim()) return;

  const amountMoney = payment.amount_money as { amount?: number } | undefined;
  const totalPrice =
    typeof amountMoney?.amount === 'number' ? String(amountMoney.amount / 100) : null;

  const paidAt =
    (typeof payment.created_at === 'string' ? payment.created_at : null) ||
    (typeof payment.updated_at === 'string' ? payment.updated_at : null) ||
    (typeof envelope.created_at === 'string' ? envelope.created_at : null);

  if (!totalPrice || !paidAt) return;

  const discountCodes = extractSquareDiscountCodes(payment);
  const discountAmount = squareDiscountAmountCents(payment);

  await processDailyMetrics({
    userId,
    checkoutId,
    totalPrice,
    paidAt,
    hasDiscount: discountCodes.length > 0
  });

  if (discountCodes.length === 0) return;

  for (const discountCode of discountCodes) {
    await incrementCampaignUsage({
      userId,
      discountCode,
      totalPrice,
      discountAmount,
      platform: Provider.SQUARE,
      checkoutId,
      paidAt
    });
  }
}
