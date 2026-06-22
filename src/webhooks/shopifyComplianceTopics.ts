export const SHOPIFY_COMPLIANCE_TOPICS = [
  'customers/data_request',
  'customers/redact',
  'shop/redact'
] as const;

export type ShopifyComplianceTopic = (typeof SHOPIFY_COMPLIANCE_TOPICS)[number];

const COMPLIANCE_TOPIC_SET = new Set<string>(SHOPIFY_COMPLIANCE_TOPICS);

export function isShopifyComplianceTopic(topic: string): topic is ShopifyComplianceTopic {
  return COMPLIANCE_TOPIC_SET.has(topic);
}
