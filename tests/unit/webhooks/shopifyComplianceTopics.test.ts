import {
  isShopifyComplianceTopic,
  SHOPIFY_COMPLIANCE_TOPICS
} from '@/webhooks/shopifyComplianceTopics';

describe('shopifyComplianceTopics', () => {
  it('includes all mandatory App Store compliance topics', () => {
    expect(SHOPIFY_COMPLIANCE_TOPICS).toEqual([
      'customers/data_request',
      'customers/redact',
      'shop/redact'
    ]);
  });

  it('recognizes compliance topics and rejects order topics', () => {
    expect(isShopifyComplianceTopic('customers/redact')).toBe(true);
    expect(isShopifyComplianceTopic('shop/redact')).toBe(true);
    expect(isShopifyComplianceTopic('orders/paid')).toBe(false);
  });
});
