/**
 * Webhook ingress configuration (Shopify / Square / GMB Pub/Sub).
 */

export type WebhookDeviceTarget = 'primary' | 'all_active';

export interface WebhookConfig {
  enabled: boolean;
  publicBaseUrl: string;
  mqttPublishEnabled: boolean;
  gmbFastPathOnly: boolean;
  deviceTarget: WebhookDeviceTarget;
  enableDailyMetrics: boolean;
  shopifyClientSecret?: string;
  squareWebhookSignatureKey?: string;
  gmbPubsubAudience?: string;
  gmbPubsubServiceAccountEmail?: string;
  gmbPubsubSkipAuthVerify: boolean;
  googleBusinessClientId?: string;
  googleBusinessClientSecret?: string;
}

const GMB_WEBHOOK_PATH = '/api/webhooks/google-business-reviews';
const SQUARE_WEBHOOK_PATH = '/api/pos-promotions/webhooks/square';

const PUBLIC_BASE_URL_ENV_HINT =
  'WEBHOOK_PUBLIC_BASE_URL (or NEXT_PUBLIC_MQTT_PUBLIC_URL, NEXT_PUBLIC_APP_URL, PUBLIC_APP_URL)';

export function loadWebhookConfig(): WebhookConfig {
  const publicBaseUrl = (
    process.env.WEBHOOK_PUBLIC_BASE_URL ||
    process.env.NEXT_PUBLIC_MQTT_PUBLIC_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.PUBLIC_APP_URL ||
    ''
  ).replace(/\/+$/, '');

  // Prefer base URL + path (mirrors statsnapp's NEXT_PUBLIC_APP_URL + /api/webhooks/google-business-reviews).
  // GMB_PUBSUB_AUDIENCE is a fallback for when no base URL env var is set.
  let gmbPubsubAudience: string | undefined;
  if (publicBaseUrl) {
    const base = publicBaseUrl.endsWith(GMB_WEBHOOK_PATH)
      ? publicBaseUrl
      : `${publicBaseUrl}${GMB_WEBHOOK_PATH}`;
    gmbPubsubAudience = base;
  } else {
    gmbPubsubAudience = process.env.GMB_PUBSUB_AUDIENCE?.trim() || undefined;
  }

  const deviceTargetRaw = (process.env.WEBHOOK_DEVICE_TARGET || 'primary').toLowerCase();
  const deviceTarget: WebhookDeviceTarget =
    deviceTargetRaw === 'all_active' ? 'all_active' : 'primary';

  return {
    enabled: process.env.WEBHOOK_ENABLED !== 'false',
    publicBaseUrl,
    mqttPublishEnabled: process.env.WEBHOOK_MQTT_PUBLISH_ENABLED !== 'false',
    gmbFastPathOnly: process.env.WEBHOOK_GMB_FAST_PATH_ONLY === 'true',
    deviceTarget,
    enableDailyMetrics: process.env.ENABLE_DAILY_METRICS !== 'false',
    shopifyClientSecret:
      process.env.SHOPIFY_CLIENT_SECRET?.trim() ||
      process.env.SHOPIFY_API_SECRET?.trim(),
    squareWebhookSignatureKey: process.env.SQUARE_WEBHOOK_SIGNATURE_KEY?.trim(),
    gmbPubsubAudience,
    gmbPubsubServiceAccountEmail: process.env.GMB_PUBSUB_SERVICE_ACCOUNT_EMAIL?.trim(),
    gmbPubsubSkipAuthVerify: process.env.GMB_PUBSUB_SKIP_AUTH_VERIFY === 'true',
    googleBusinessClientId: process.env.GOOGLE_BUSINESS_CLIENT_ID?.trim(),
    googleBusinessClientSecret: process.env.GOOGLE_BUSINESS_CLIENT_SECRET?.trim()
  };
}

export function getSquareWebhookUrl(publicBaseUrl: string): string {
  const base = publicBaseUrl.replace(/\/$/, '');
  return `${base}${SQUARE_WEBHOOK_PATH}`;
}

export function validateWebhookConfig(config: WebhookConfig, env: string): void {
  if (!config.enabled) return;

  if (env === 'production') {
    if (!config.publicBaseUrl) {
      throw new Error(
        `${PUBLIC_BASE_URL_ENV_HINT} is required in production when webhooks are enabled (Square HMAC canonical URL).`
      );
    }
    if (!config.shopifyClientSecret) {
      throw new Error(
        'SHOPIFY_CLIENT_SECRET is required in production when webhooks are enabled.'
      );
    }
    if (!config.squareWebhookSignatureKey) {
      throw new Error(
        'SQUARE_WEBHOOK_SIGNATURE_KEY is required in production when webhooks are enabled (or per-merchant keys).'
      );
    }
    if (!config.gmbPubsubAudience) {
      throw new Error(
        `GMB_PUBSUB_AUDIENCE or ${PUBLIC_BASE_URL_ENV_HINT} is required in production for GMB Pub/Sub push.`
      );
    }
  }
}
