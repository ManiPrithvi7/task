import { OAuth2Client } from 'google-auth-library';
import type { WebhookConfig } from '../../config/webhookConfig';

const GMB_WEBHOOK_PATH = '/api/webhooks/google-business-reviews';

export type PubSubPushVerificationResult = {
  valid: boolean;
  error?: string;
  payload?: { email?: string; sub?: string };
};

export const extractBearerToken = (authHeader: string): string | null => {
  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer') return null;
  return parts[1]?.trim() || null;
};

export const getGmbPubsubAudience = (webhookConfig: WebhookConfig): string | null => {
  if (webhookConfig.gmbPubsubAudience) return webhookConfig.gmbPubsubAudience;
  if (webhookConfig.publicBaseUrl) {
    return `${webhookConfig.publicBaseUrl.replace(/\/$/, '')}${GMB_WEBHOOK_PATH}`;
  }
  return null;
};

export const verifyPubSubPushRequest = async (
  authHeader: string | null,
  webhookConfig: WebhookConfig,
  isProduction: boolean,
  oAuth2Client?: OAuth2Client
): Promise<PubSubPushVerificationResult> => {
  if (webhookConfig.gmbPubsubSkipAuthVerify && !isProduction) {
    return { valid: true };
  }

  if (!authHeader) {
    return { valid: false, error: 'No token provided' };
  }

  const token = extractBearerToken(authHeader);
  if (!token) {
    return { valid: false, error: 'Malformed token' };
  }

  const audience = getGmbPubsubAudience(webhookConfig);
  if (!audience) {
    return {
      valid: false,
      error: 'GMB_PUBSUB_AUDIENCE or WEBHOOK_PUBLIC_BASE_URL is not configured'
    };
  }

  const client = oAuth2Client ?? new OAuth2Client();

  try {
    const ticket = await client.verifyIdToken({ idToken: token, audience });
    const payload = ticket.getPayload();
    if (!payload) {
      return { valid: false, error: 'Invalid token payload' };
    }

    const expectedEmail = webhookConfig.gmbPubsubServiceAccountEmail;
    if (expectedEmail && payload.email !== expectedEmail) {
      return { valid: false, error: 'Token service account email mismatch' };
    }

    return {
      valid: true,
      payload: {
        email: payload.email,
        sub: payload.sub
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Token verification failed';
    return { valid: false, error: message };
  }
};
