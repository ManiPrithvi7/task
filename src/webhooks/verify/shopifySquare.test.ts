import {
  verifyShopifyWebhook,
  verifySquareWebhook
} from './shopifySquare';

describe('shopifySquare verifiers', () => {
  const secret = 'test-shopify-secret';
  const body = '{"id":1}';

  it('verifies valid Shopify HMAC', () => {
    const crypto = require('crypto');
    const sig = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64');
    expect(verifyShopifyWebhook(body, sig, secret)).toBe(true);
    expect(verifyShopifyWebhook(body, 'bad', secret)).toBe(false);
  });

  it('verifies valid Square HMAC', () => {
    const key = 'square-key';
    const url = 'https://mqtt.example.com/api/pos-promotions/webhooks/square';
    const crypto = require('crypto');
    const sig = crypto
      .createHmac('sha256', key)
      .update(url + body, 'utf8')
      .digest('base64');
    expect(verifySquareWebhook(body, sig, key, url)).toBe(true);
    expect(verifySquareWebhook(body, 'bad', key, url)).toBe(false);
  });
});
