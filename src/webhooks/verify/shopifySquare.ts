import crypto from 'crypto';

export function verifyShopifyWebhook(
  body: string,
  signature: string,
  apiSecret: string
): boolean {
  if (!signature || !apiSecret) return false;

  const trimmed = signature.trim();
  const cleanSignature = trimmed.startsWith('sha256=')
    ? trimmed.slice('sha256='.length).trim()
    : trimmed;

  const digest = crypto.createHmac('sha256', apiSecret).update(body, 'utf8').digest('base64');

  try {
    const digestBuf = Buffer.from(digest, 'utf8');
    const sigBuf = Buffer.from(cleanSignature, 'utf8');
    if (digestBuf.length !== sigBuf.length) return false;
    return crypto.timingSafeEqual(digestBuf, sigBuf);
  } catch {
    return false;
  }
}

export function verifySquareWebhook(
  body: string,
  signature: string,
  signatureKey: string,
  webhookUrl: string
): boolean {
  if (!signature || !signatureKey) return false;
  const payload = body + webhookUrl;
  const hmac = crypto.createHmac('sha256', signatureKey).update(payload, 'utf8').digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature));
  } catch {
    return false;
  }
}

export function getShopifyWebhookSecret(shopDomain: string): string | null {
  const appSecret =
    process.env.SHOPIFY_CLIENT_SECRET?.trim() ||
    process.env.SHOPIFY_API_SECRET?.trim() ||
    null;
  if (appSecret) return appSecret;

  const shopKey = shopDomain.replace('.myshopify.com', '').replace(/[^a-zA-Z0-9]/g, '_');
  const shopSpecific = process.env[`SHOPIFY_WEBHOOK_SECRET_${shopKey.toUpperCase()}`];
  return shopSpecific || process.env.SHOPIFY_WEBHOOK_SECRET || null;
}

export function getSquareWebhookSignatureKey(merchantId: string): string | null {
  const merchantSpecific = process.env[`SQUARE_WEBHOOK_SIGNATURE_KEY_${merchantId}`];
  return merchantSpecific || process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || null;
}

export type WebhookVerificationResult = { valid: boolean; error?: string };

export async function verifyShopifyIngress(
  body: string,
  signature: string | null,
  shopDomain: string,
  isProduction: boolean
): Promise<WebhookVerificationResult> {
  if (!signature) {
    if (isProduction) {
      return { valid: false, error: 'Webhook signature required' };
    }
    return { valid: true };
  }

  const secret = getShopifyWebhookSecret(shopDomain);
  if (!secret) {
    if (isProduction) {
      return {
        valid: false,
        error: 'Shopify API secret not configured — set SHOPIFY_CLIENT_SECRET'
      };
    }
    return { valid: true };
  }

  if (verifyShopifyWebhook(body, signature, secret)) {
    return { valid: true };
  }
  return { valid: false, error: 'Invalid Shopify webhook signature' };
}

export async function verifySquareIngress(
  body: string,
  signature: string | null,
  merchantId: string,
  webhookUrl: string,
  isProduction: boolean
): Promise<WebhookVerificationResult> {
  if (!signature) {
    if (isProduction) {
      return { valid: false, error: 'Webhook signature required' };
    }
    return { valid: true };
  }

  const signatureKey = getSquareWebhookSignatureKey(merchantId);
  if (!signatureKey) {
    if (isProduction) {
      return { valid: false, error: 'Square webhook signature key not configured' };
    }
    return { valid: true };
  }

  if (verifySquareWebhook(body, signature, signatureKey, webhookUrl)) {
    return { valid: true };
  }
  return { valid: false, error: 'Invalid Square webhook signature' };
}
