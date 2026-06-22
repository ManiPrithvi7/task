import { Request, Response } from 'express';
import { WebhookLatencyTracker } from '@/services/webhookMetrics';
import { handleShopifyWebhook } from '@/webhooks/shopifyHandler';
import { handleSquareWebhook } from '@/webhooks/squareHandler';
import type { WebhookHandlerDeps } from '@/webhooks/types';
import * as shopifySquare from '@/webhooks/verify/shopifySquare';
import * as redisDedupe from '@/webhooks/dedupe/redisDedupe';
import { resolveShopifyUserId } from '@/webhooks/resolve/shopifyUser';
import { ingestPosOrder } from '@/services/pos/ingestPosOrder';
import { readPosDailyAggregate } from '@/services/pos/readPosDailyAggregate';
import { deliverPosScreenToUser } from '@/webhooks/posWebhookDelivery';

jest.mock('@/webhooks/verify/shopifySquare');
jest.mock('@/webhooks/dedupe/redisDedupe');
jest.mock('@/webhooks/resolve/shopifyUser', () => ({ resolveShopifyUserId: jest.fn() }));
jest.mock('@/webhooks/resolve/squareMerchant', () => ({ resolveSquareUserId: jest.fn() }));
jest.mock('@/webhooks/resolve/resolveDevices', () => ({ resolveDevicesForUser: jest.fn().mockResolvedValue([]) }));
jest.mock('@/webhooks/delivery/publishPosScreen', () => ({ publishPosScreen: jest.fn() }));
jest.mock('@/webhooks/shopifyAsyncMetrics', () => ({ scheduleShopifyAsyncMetrics: jest.fn() }));
jest.mock('@/webhooks/squareAsyncMetrics', () => ({ scheduleSquareAsyncMetrics: jest.fn() }));
jest.mock('@/services/pos/ingestPosOrder', () => ({ ingestPosOrder: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/services/pos/readPosDailyAggregate', () => ({
  readPosDailyAggregate: jest.fn().mockResolvedValue({ orderCountToday: 3, topSellerLine: 'Hat' })
}));
jest.mock('@/webhooks/posWebhookDelivery', () => ({
  deliverPosScreenToUser: jest.fn().mockResolvedValue({ published: true, clientId: 'dev-1', topic: 'proof.mqtt/dev-1/pos' }),
  isShopifyPaidOrder: jest.requireActual('@/webhooks/posWebhookDelivery').isShopifyPaidOrder
}));

const mockVerifyShopify = shopifySquare.verifyShopifyIngress as jest.MockedFunction<
  typeof shopifySquare.verifyShopifyIngress
>;
const mockVerifySquare = shopifySquare.verifySquareIngress as jest.MockedFunction<
  typeof shopifySquare.verifySquareIngress
>;
const mockDedupe = redisDedupe.tryClaimWebhookDedupe as jest.MockedFunction<
  typeof redisDedupe.tryClaimWebhookDedupe
>;

function mockRes(): Response {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis()
  } as unknown as Response;
  return res;
}

const baseDeps: WebhookHandlerDeps = {
  mqttClient: {} as WebhookHandlerDeps['mqttClient'],
  topicRoot: 'proof.mqtt',
  appEnv: 'production',
  webhookConfig: {
    enabled: true,
    publicBaseUrl: 'https://example.com',
    mqttPublishEnabled: false,
    gmbFastPathOnly: false,
    deviceTarget: 'primary',
    enableDailyMetrics: false,
    shopifyClientSecret: 'secret',
    squareWebhookSignatureKey: 'sq-key',
    gmbPubsubSkipAuthVerify: false
  }
};

function setupMetricsTest(): jest.SpyInstance {
  const markVerifiedSpy = jest.spyOn(WebhookLatencyTracker.prototype, 'markVerified');
  mockDedupe.mockResolvedValue(true);
  return markVerifiedSpy;
}

function teardownMetricsTest(markVerifiedSpy: jest.SpyInstance): void {
  jest.clearAllMocks();
  markVerifiedSpy.mockRestore();
}

describe('Shopify webhook metrics', () => {
  it('does not call markVerified when verification fails', async () => {
    const markVerifiedSpy = setupMetricsTest();
    mockVerifyShopify.mockResolvedValue({ valid: false, error: 'bad sig' });
    const req = {
      headers: {
        'x-shopify-shop-domain': 'shop.myshopify.com',
        'x-shopify-topic': 'orders/paid',
        'x-shopify-hmac-sha256': 'x'
      },
      rawBody: Buffer.from('{}')
    } as unknown as Request;
    const res = mockRes();

    await handleShopifyWebhook(req, res, baseDeps);

    expect(markVerifiedSpy).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    teardownMetricsTest(markVerifiedSpy);
  });

  it('compliance topic: acks without user resolution or order parsing', async () => {
    const markVerifiedSpy = setupMetricsTest();
    mockVerifyShopify.mockResolvedValue({ valid: true });
    const req = {
      headers: {
        'x-shopify-shop-domain': 'shop.myshopify.com',
        'x-shopify-topic': 'customers/redact',
        'x-shopify-hmac-sha256': 'x'
      },
      rawBody: Buffer.from('{}')
    } as unknown as Request;
    const res = mockRes();

    await handleShopifyWebhook(req, res, baseDeps);

    expect(resolveShopifyUserId).not.toHaveBeenCalled();
    expect(ingestPosOrder).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ acknowledged: true, compliance: true })
    );
    teardownMetricsTest(markVerifiedSpy);
  });

  it('paid order: ingest → read aggregate → deliver absolute count', async () => {
    const markVerifiedSpy = setupMetricsTest();
    mockVerifyShopify.mockResolvedValue({ valid: true });
    (resolveShopifyUserId as jest.Mock).mockResolvedValue('user-shop');
    const req = {
      headers: {
        'x-shopify-shop-domain': 'shop.myshopify.com',
        'x-shopify-topic': 'orders/paid',
        'x-shopify-hmac-sha256': 'x'
      },
      rawBody: Buffer.from(
        JSON.stringify({
          id: 99,
          financial_status: 'paid',
          processed_at: '2026-06-04T10:00:00Z',
          current_total_price: '25.00',
          line_items: [{ name: 'Hat' }]
        })
      )
    } as unknown as Request;
    const res = mockRes();

    await handleShopifyWebhook(req, res, baseDeps);

    expect(ingestPosOrder).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-shop', platform: 'shopify', orderId: '99' })
    );
    expect(readPosDailyAggregate).toHaveBeenCalledWith(
      'user-shop',
      expect.any(Date),
      expect.objectContaining({ platform: 'shopify' })
    );
    expect(deliverPosScreenToUser).toHaveBeenCalledWith(
      baseDeps,
      'user-shop',
      'shopify',
      3,
      'Hat'
    );
    expect(res.status).toHaveBeenCalledWith(200);
    teardownMetricsTest(markVerifiedSpy);
  });
});

describe('Square webhook metrics', () => {
  it('does not call markVerified when verification fails', async () => {
    const markVerifiedSpy = setupMetricsTest();
    mockVerifySquare.mockResolvedValue({ valid: false, error: 'bad sig' });
    const req = {
      headers: { 'x-square-hmacsha256-signature': 'x' },
      rawBody: Buffer.from(JSON.stringify({ merchant_id: 'm1', type: 'payment.created' })),
      protocol: 'https',
      get: jest.fn().mockReturnValue('example.com')
    } as unknown as Request;
    const res = mockRes();

    await handleSquareWebhook(req, res, baseDeps);

    expect(markVerifiedSpy).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    teardownMetricsTest(markVerifiedSpy);
  });
});
