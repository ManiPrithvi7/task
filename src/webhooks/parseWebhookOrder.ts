import { getIdString, parseSquareWebhookEnvelope } from '../lib/socials/integrations';

export type WebhookOrderAudit = {
  orderId: string;
  totalAmount?: number;
  currency?: string;
  itemCount?: number;
};

const getOrderId = (value: unknown): string | null => {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
};

export function parseShopifyOrderAudit(rawBody: string): WebhookOrderAudit | null {
  try {
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    const orderId = getOrderId(body.id) || getOrderId(body.checkout_id);
    if (!orderId) return null;

    const priceRaw =
      typeof body.current_total_price === 'string'
        ? body.current_total_price
        : typeof body.total_price === 'string'
          ? body.total_price
          : null;
    const totalAmount = priceRaw !== null ? parseFloat(priceRaw) : undefined;

    const currency = typeof body.currency === 'string' ? body.currency : undefined;
    const lineItems = Array.isArray(body.line_items) ? body.line_items : undefined;
    const itemCount = lineItems?.length;

    return {
      orderId,
      totalAmount: totalAmount !== undefined && Number.isFinite(totalAmount) ? totalAmount : undefined,
      currency,
      itemCount
    };
  } catch {
    return null;
  }
}

export function parseSquareOrderAudit(rawBody: string): WebhookOrderAudit | null {
  const envelope = parseSquareWebhookEnvelope(rawBody);
  if (!envelope) return null;

  const payment = envelope.data?.object?.payment as Record<string, unknown> | undefined;
  if (!payment) return null;

  const orderId = getIdString(payment.order_id) || getIdString(payment.id);
  if (!orderId?.trim()) return null;

  const amountMoney = payment.amount_money as { amount?: number; currency?: string } | undefined;
  const totalAmount =
    typeof amountMoney?.amount === 'number' ? amountMoney.amount / 100 : undefined;
  const currency = typeof amountMoney?.currency === 'string' ? amountMoney.currency : undefined;

  return {
    orderId,
    totalAmount: totalAmount !== undefined && Number.isFinite(totalAmount) ? totalAmount : undefined,
    currency
  };
}
