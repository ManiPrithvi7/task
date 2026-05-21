import { OAuth2Client } from 'google-auth-library';
import mongoose from 'mongoose';
import { Social, Provider } from '../../models/Social';
import { logger } from '../../utils/logger';
import type { WebhookConfig } from '../../config/webhookConfig';

function isInvalidGrant(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { message?: string; response?: { data?: { error?: string } } };
  if (e.message?.includes('invalid_grant')) return true;
  if (e.response?.data?.error === 'invalid_grant') return true;
  return false;
}

export function createGoogleBusinessOAuth2Client(webhookConfig: WebhookConfig): OAuth2Client | null {
  const clientId = webhookConfig.googleBusinessClientId;
  const clientSecret = webhookConfig.googleBusinessClientSecret;
  if (!clientId || !clientSecret) return null;

  const redirectUri =
    process.env.GOOGLE_BUSINESS_REDIRECT_URI?.trim() ||
    (webhookConfig.publicBaseUrl
      ? `${webhookConfig.publicBaseUrl.replace(/\/$/, '')}/api/social/google-business`
      : 'http://localhost:3000/api/social/google-business');

  return new OAuth2Client(clientId, clientSecret, redirectUri);
}

async function refreshAccessTokenIfNeeded(
  social: {
    _id: unknown;
    accessToken: string;
    refreshToken: string;
    tokenExp: string;
    tokenCreatedAt?: Date;
  },
  oauth2Client: OAuth2Client
): Promise<string | null> {
  if (!social.refreshToken?.trim()) return null;

  const currentTime = Math.floor(Date.now() / 1000);
  const tokenCreatedAt = Math.floor(new Date(social.tokenCreatedAt ?? Date.now()).getTime() / 1000);
  const expiresInSeconds = Number.parseInt(social.tokenExp, 10) || 3600;
  const tokenExpiryTime = tokenCreatedAt + expiresInSeconds;
  const isExpired = currentTime >= tokenExpiryTime - 300;

  if (!isExpired) return social.accessToken;

  oauth2Client.setCredentials({ refresh_token: social.refreshToken });

  try {
    const { credentials } = await oauth2Client.refreshAccessToken();
    if (!credentials.access_token) return null;

    const tokenExp = credentials.expiry_date
      ? Math.floor((credentials.expiry_date - Date.now()) / 1000)
      : 3600;

    await Social.updateOne(
      { _id: social._id },
      {
        accessToken: credentials.access_token,
        tokenExp: String(tokenExp),
        tokenCreatedAt: new Date()
      }
    );

    return credentials.access_token;
  } catch (err) {
    if (isInvalidGrant(err)) {
      logger.warn('[GMB_OAUTH] invalid_grant — reconnect Google Business in app');
    } else {
      logger.error('[GMB_OAUTH] refresh failed', {
        error: err instanceof Error ? err.message : String(err)
      });
    }
    return null;
  }
}

export async function getValidOAuth2Client(
  userId: string,
  webhookConfig: WebhookConfig
): Promise<OAuth2Client | null> {
  const oauth2Client = createGoogleBusinessOAuth2Client(webhookConfig);
  if (!oauth2Client) return null;

  const social = await Social.findOne({
    userId: new mongoose.Types.ObjectId(userId),
    provider: Provider.GOOGLE_BUSINESS
  }).lean();

  if (!social) return null;

  const accessToken = await refreshAccessTokenIfNeeded(social, oauth2Client);
  if (!accessToken) return null;

  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: social.refreshToken
  });

  return oauth2Client;
}
