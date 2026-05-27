import { Request, Response } from 'express';
import { WebhookLatencyTracker } from '../services/webhookMetrics';
import { handleShopifyWebhook } from './shopifyHandler';
import { handleSquareWebhook } from './squareHandler';
import type { WebhookHandlerDeps } from './types';
import * as shopifySquare from './verify/shopifySquare';
import * as redisDedupe from './dedupe/redisDedupe';

jest.mock('./verify/shopifySquare');
jest.mock('./dedupe/redisDedupe');
jest.mock('./resolve/shopifyUser', () => ({ resolveShopifyUserId: jest.fn() }));
jest.mock('./resolve/squareMerchant', () => ({ resolveSquareUserId: jest.fn() }));
jest.mock('./resolve/resolveDevices', () => ({ resolveDevicesForUser: jest.fn().mockResolvedValue([]) }));
jest.mock('./delivery/publishPosScreen', () => ({ publishPosScreen: jest.fn() }));
jest.mock('./shopifyAsyncMetrics', () => ({ scheduleShopifyAsyncMetrics: jest.fn() }));

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

describe('webhook handler metrics', () => {
  let markVerifiedSpy: jest.SpyInstance;

  beforeEach(() => {
    markVerifiedSpy = jest.spyOn(WebhookLatencyTracker.prototype, 'markVerified');
    mockDedupe.mockResolvedValue(true);
  });

  afterEach(() => {
    jest.clearAllMocks();
    markVerifiedSpy.mockRestore();
  });

  it('Shopify: does not call markVerified when verification fails', async () => {
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
  });

  it('Square: does not call markVerified when verification fails', async () => {
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
  });
});
