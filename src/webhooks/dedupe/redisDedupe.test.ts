import { createHash } from 'crypto';
import {
  buildShopifyDedupeKey,
  buildSquareDedupeKey
} from './redisDedupe';

describe('webhook dedupe keys', () => {
  it('builds shopify key from checkout_id', () => {
    const raw = JSON.stringify({ checkout_id: 12345, id: 99 });
    const key = buildShopifyDedupeKey('shop.myshopify.com', 'orders/paid', raw);
    expect(key).toBe('shopify:shop.myshopify.com:orders/paid:12345');
  });

  it('builds shopify key from hash when no id', () => {
    const raw = 'not-json';
    const key = buildShopifyDedupeKey('shop.myshopify.com', 'orders/paid', raw);
    const expected = createHash('sha256').update(raw).digest('hex');
    expect(key).toBe(`shopify:shop.myshopify.com:orders/paid:${expected}`);
  });

  it('builds square key from event_id', () => {
    const raw = JSON.stringify({ merchant_id: 'm1', type: 'payment.created', event_id: 'evt-1' });
    const key = buildSquareDedupeKey('m1', 'payment.created', 'evt-1', raw);
    expect(key).toBe('square:m1:payment.created:evt-1');
  });

  it('builds gmb-style key format', () => {
    const account = 'accounts/123';
    const location = 'locations/456';
    const review = 'reviews/789';
    expect(`gmb:${account}:${location}:${review}`).toBe(
      'gmb:accounts/123:locations/456:reviews/789'
    );
  });
});
