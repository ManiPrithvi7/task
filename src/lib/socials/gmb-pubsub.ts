import { OAuth2Client } from 'google-auth-library';
import type { GmbPubsubVerifyConfig, PubSubPushVerificationResult } from './types';

export type { GmbPubsubVerifyConfig, PubSubPushVerificationResult } from './types';

export const extractBearerToken = (authHeader: string): string | null => {
  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer') return null;
  return parts[1]?.trim() || null;
};

export const getGmbPubsubAudience = (cfg: GmbPubsubVerifyConfig): string | null =>
  cfg.audience?.trim() || null;

export const verifyPubSubPushRequest = async (
  authHeader: string | null,
  cfg: GmbPubsubVerifyConfig,
  isProduction: boolean
): Promise<PubSubPushVerificationResult> => {
  if (cfg.skipAuthVerify && !isProduction) return { valid: true };
  if (!authHeader) return { valid: false, error: 'No token provided' };

  const token = extractBearerToken(authHeader);
  if (!token) return { valid: false, error: 'Malformed token' };

  const audience = getGmbPubsubAudience(cfg);
  if (!audience) {
    return { valid: false, error: 'GMB_PUBSUB_AUDIENCE or WEBHOOK_PUBLIC_BASE_URL is not configured' };
  }

  try {
    const ticket = await new OAuth2Client().verifyIdToken({ idToken: token, audience });
    const payload = ticket.getPayload();
    if (!payload) return { valid: false, error: 'Invalid token payload' };

    const expectedEmail = cfg.serviceAccountEmail?.trim();
    if (expectedEmail && payload.email !== expectedEmail) {
      return { valid: false, error: 'Token service account email mismatch' };
    }

    return { valid: true, payload: { email: payload.email, sub: payload.sub } };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Token verification failed'
    };
  }
};
