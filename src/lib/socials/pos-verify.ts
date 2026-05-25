import type { WebhookConfig } from '../../config/webhookConfig';
import { verifyShopifyWebhook, verifySquareWebhook } from './integrations';

export type WebhookVerificationResult = { valid: boolean; error?: string };

export function getShopifyWebhookSecret(cfg: WebhookConfig): string | null {
  return cfg.shopifyClientSecret?.trim() || null;
}

export function getSquareWebhookSignatureKey(
  merchantId: string,
  cfg: WebhookConfig
): string | null {
  const merchantSpecific = process.env[`SQUARE_WEBHOOK_SIGNATURE_KEY_${merchantId}`]?.trim();
  return merchantSpecific || cfg.squareWebhookSignatureKey?.trim() || null;
}

export async function verifyShopifyIngress(
  body: string,
  signature: string | null,
  cfg: WebhookConfig,
  isProduction: boolean
): Promise<WebhookVerificationResult> {
  if (!signature) {
    return isProduction
      ? { valid: false, error: 'Webhook signature required' }
      : { valid: true };
  }
  const secret = getShopifyWebhookSecret(cfg);
  if (!secret) {
    return isProduction
      ? { valid: false, error: 'SHOPIFY_CLIENT_SECRET not configured' }
      : { valid: true };
  }
  return verifyShopifyWebhook(body, signature, secret)
    ? { valid: true }
    : { valid: false, error: 'Invalid Shopify webhook signature' };
}

export async function verifySquareIngress(
  body: string,
  signature: string | null,
  merchantId: string,
  notificationUrl: string,
  cfg: WebhookConfig,
  isProduction: boolean
): Promise<WebhookVerificationResult> {
  if (!signature) {
    return isProduction
      ? { valid: false, error: 'Webhook signature required' }
      : { valid: true };
  }
  const signatureKey = getSquareWebhookSignatureKey(merchantId, cfg);
  if (!signatureKey) {
    return isProduction
      ? { valid: false, error: 'Square webhook signature key not configured' }
      : { valid: true };
  }
  return verifySquareWebhook(body, signature, signatureKey, notificationUrl)
    ? { valid: true }
    : { valid: false, error: 'Invalid Square webhook signature' };
}
