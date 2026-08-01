/**
 * Shopify / Square webhook HMAC verifiers (from @proof-socials/socials via integrations).
 * Square signs notificationUrl + rawBody (not body + url).
 */

import crypto from 'crypto';
import { verifyShopifyWebhook, verifySquareWebhook } from '@/lib/socials/integrations';

describe('shopifySquare verifiers', () => {
  const secret = 'test-shopify-secret';
  const body = '{"id":1}';

  it('verifies valid Shopify HMAC', () => {
    const sig = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64');
    expect(verifyShopifyWebhook(body, sig, secret)).toBe(true);
    expect(verifyShopifyWebhook(body, 'bad', secret)).toBe(false);
  });

  it('verifies valid Square HMAC (notificationUrl + body)', () => {
    const key = 'square-key';
    const url = 'https://mqtt.example.com/api/pos-promotions/webhooks/square';
    const sig = crypto
      .createHmac('sha256', key)
      .update(url + body, 'utf8')
      .digest('base64');
    expect(verifySquareWebhook(body, sig, key, url)).toBe(true);
    expect(verifySquareWebhook(body, 'bad', key, url)).toBe(false);
  });

  it('rejects Square HMAC computed with reversed body+url order', () => {
    const key = 'square-key';
    const url = 'https://mqtt.example.com/api/pos-promotions/webhooks/square';
    const wrongOrderSig = crypto
      .createHmac('sha256', key)
      .update(body + url, 'utf8')
      .digest('base64');
    expect(verifySquareWebhook(body, wrongOrderSig, key, url)).toBe(false);
  });
});
