import { OAuth2Client } from 'google-auth-library';
import { Social, Provider } from '../../models/Social';
import { businessOwnerMatch } from '../../lib/socials/findOwnedSocial';
import { logger } from '../../utils/logger';
import type { WebhookConfig } from '../../config/webhookConfig';
import { REDIS_KEYS } from '../../constants/redisKeys';
import { getRedisService } from '../redisService';
import { getIgDeviceRuntimeCache } from '../igDeviceRuntimeCache';

const GMB_TOKEN_SKEW_SEC = 300;
const DEVICE_HASH_TTL_SEC = 7 * 24 * 3600;

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

type GmbTokenRecord = {
  accessToken: string;
  tokenExp: string;
  tokenCreatedAtMs: number;
  refreshed: boolean;
};

function cachedGmbToken(
  businessId: string,
  deviceId?: string
): { accessToken?: string; tokenExp?: string; tokenCreatedAt?: number } {
  const runtime = getIgDeviceRuntimeCache();
  const seen = new Set<string>();
  const ids = deviceId ? [deviceId, ...runtime.deviceIdsForBusiness(businessId)] : runtime.deviceIdsForBusiness(businessId);
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const token = runtime.gmbToken(id);
    if (token.tokenExp && token.tokenCreatedAt !== undefined && token.accessToken) return token;
  }
  return {};
}

function isGmbTokenExpired(tokenExp: string | undefined, tokenCreatedAtMs: number | undefined): boolean {
  if (tokenCreatedAtMs === undefined || !Number.isFinite(tokenCreatedAtMs)) return true;
  const expiresInSeconds = Number.parseInt(tokenExp ?? '', 10) || 3600;
  const currentTime = Math.floor(Date.now() / 1000);
  const tokenExpiryTime = Math.floor(tokenCreatedAtMs / 1000) + expiresInSeconds;
  return currentTime >= tokenExpiryTime - GMB_TOKEN_SKEW_SEC;
}

async function persistGmbTokenCache(
  businessId: string,
  deviceId: string | undefined,
  token: GmbTokenRecord
): Promise<void> {
  const runtime = getIgDeviceRuntimeCache();
  const ids = new Set(runtime.deviceIdsForBusiness(businessId));
  if (deviceId) ids.add(deviceId);
  if (ids.size === 0) return;

  for (const id of ids) {
    runtime.setGmbToken(id, businessId, token.accessToken, token.tokenExp, token.tokenCreatedAtMs);
  }

  const redisSvc = getRedisService();
  if (!redisSvc?.isRedisConnected()) return;
  const client = redisSvc.getClient();
  const fields = {
    gmb_accessToken: token.accessToken,
    gmb_token_exp: token.tokenExp,
    gmb_token_created_at: String(token.tokenCreatedAtMs)
  };
  for (const id of ids) {
    try {
      const key = REDIS_KEYS.deviceHash(id);
      await client.hSet(key, fields);
      await client.expire(key, DEVICE_HASH_TTL_SEC);
    } catch (err: unknown) {
      logger.warn('[GMB_OAUTH] token cache write failed', {
        deviceId: id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
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
): Promise<GmbTokenRecord | null> {
  if (!social.refreshToken?.trim()) return null;

  const createdMs = social.tokenCreatedAt ? new Date(social.tokenCreatedAt).getTime() : undefined;
  const expiresInSeconds = Number.parseInt(social.tokenExp, 10) || 3600;
  if (!isGmbTokenExpired(social.tokenExp, createdMs)) {
    return {
      accessToken: social.accessToken,
      tokenExp: String(expiresInSeconds),
      tokenCreatedAtMs: createdMs as number,
      refreshed: false
    };
  }

  oauth2Client.setCredentials({ refresh_token: social.refreshToken });

  try {
    const { credentials } = await oauth2Client.refreshAccessToken();
    if (!credentials.access_token) return null;

    const now = new Date();
    const tokenExp = credentials.expiry_date
      ? Math.max(0, Math.floor((credentials.expiry_date - now.getTime()) / 1000))
      : 3600;

    await Social.updateOne(
      { _id: social._id },
      {
        accessToken: credentials.access_token,
        tokenExp: String(tokenExp),
        tokenCreatedAt: now
      }
    );

    return {
      accessToken: credentials.access_token,
      tokenExp: String(tokenExp),
      tokenCreatedAtMs: now.getTime(),
      refreshed: true
    };
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
  businessId: string,
  webhookConfig: WebhookConfig,
  deviceId?: string
): Promise<OAuth2Client | null> {
  const oauth2Client = createGoogleBusinessOAuth2Client(webhookConfig);
  if (!oauth2Client) return null;

  const social = await Social.findOne({
    provider: Provider.GOOGLE_BUSINESS,
    ...businessOwnerMatch(businessId)
  }).lean();

  if (!social) return null;

  const cached = cachedGmbToken(businessId, deviceId);
  const cacheComplete = Boolean(cached.accessToken && cached.tokenExp && cached.tokenCreatedAt !== undefined);
  const createdAt =
    cached.tokenCreatedAt !== undefined ? new Date(cached.tokenCreatedAt) : social.tokenCreatedAt;

  const token = await refreshAccessTokenIfNeeded(
    {
      _id: social._id,
      accessToken: cached.accessToken ?? social.accessToken,
      refreshToken: social.refreshToken,
      tokenExp: cached.tokenExp ?? social.tokenExp,
      tokenCreatedAt: createdAt
    },
    oauth2Client
  );
  if (!token) return null;

  if (token.refreshed || !cacheComplete) {
    await persistGmbTokenCache(businessId, deviceId, token);
  }

  oauth2Client.setCredentials({
    access_token: token.accessToken,
    refresh_token: social.refreshToken
  });

  return oauth2Client;
}
