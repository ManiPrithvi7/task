import mongoose from 'mongoose';
import { Social, Provider } from '../models/Social';
import { GoogleBusinessProfile } from '../models/GoogleBusinessProfile';
import { GoogleBusinessLocation } from '../models/GoogleBusinessLocation';
import { getLocalIntegrationsCache } from './localCaches';
import { getIgDeviceRuntimeCache } from './igDeviceRuntimeCache';
import { logger } from '../utils/logger';

const CACHE_KEY_PREFIX = 'user:integrations:';

export type InstagramIntegrationCache = {
  socialId: string;
  accessToken: string;
  accountId: string;
  expiresAt?: string;
};

export type GmbIntegrationCache = {
  socialId: string;
  accessToken: string;
  refreshToken?: string;
  locationId?: string;
  accountId: string;
};

export type PosIntegrationCache = {
  socialId: string;
  platform: 'shopify' | 'square';
  accessToken: string;
  refreshToken?: string;
  storeId: string;
  expiresAt?: string;
};

export type UserIntegrationCache = {
  userId: string;
  instagram?: InstagramIntegrationCache;
  gmb?: GmbIntegrationCache;
  pos?: PosIntegrationCache;
  updatedAt: string;
};

export function getUserIntegrationsCacheTtlSec(): number {
  const n = Number(process.env.USER_INTEGRATIONS_CACHE_TTL_SEC);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 86400;
}

function cacheKey(userId: string): string {
  return `${CACHE_KEY_PREFIX}${userId}`;
}

function ttlMs(): number {
  return getUserIntegrationsCacheTtlSec() * 1000;
}

/** Prefer fresher tokens from device runtime cache when present. */
function enrichTokensFromRuntime(userId: string, cache: UserIntegrationCache): UserIntegrationCache {
  const devices = getIgDeviceRuntimeCache().getByUserId(userId);
  for (const d of devices) {
    if (cache.instagram && d.igAccessToken?.trim()) {
      cache.instagram.accessToken = d.igAccessToken.trim();
      if (d.igAccountId?.trim()) cache.instagram.accountId = d.igAccountId.trim();
    }
    if (cache.gmb && d.gmbAccessToken?.trim()) {
      cache.gmb.accessToken = d.gmbAccessToken.trim();
      if (d.gmbProfileId?.trim() && !cache.gmb.locationId) {
        cache.gmb.locationId = d.gmbProfileId.trim();
      }
    }
  }
  return cache;
}

async function resolveGmbLocationId(socialId: mongoose.Types.ObjectId): Promise<string | undefined> {
  const profiles = await GoogleBusinessProfile.find({ socialId }).select({ _id: 1 }).lean();
  const profileIds = profiles.map((p) => p._id);
  if (profileIds.length === 0) return undefined;

  const location = await GoogleBusinessLocation.findOne({ profileId: { $in: profileIds } })
    .sort({ updatedAt: -1 })
    .select({ locationId: 1 })
    .lean();

  return location?.locationId;
}

/**
 * Build and persist integration cache from Mongo (24h TTL).
 * Returns null on failure — callers must handle gracefully.
 */
export async function cacheUserIntegrations(userId: string): Promise<UserIntegrationCache | null> {
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    logger.warn('[USER_INTEGRATIONS] Invalid userId', { userId });
    return null;
  }

  try {
    const userOid = new mongoose.Types.ObjectId(userId);
    const socials = await Social.find({ userId: userOid }).lean();
    const cache: UserIntegrationCache = {
      userId,
      updatedAt: new Date().toISOString()
    };

    for (const social of socials) {
      const socialId = String(social._id);

      switch (social.provider) {
        case Provider.INSTAGRAM:
          cache.instagram = {
            socialId,
            accessToken: social.accessToken,
            accountId: social.socialAccountId,
            expiresAt: social.tokenExp || undefined
          };
          break;

        case Provider.GOOGLE_BUSINESS: {
          const locationId = await resolveGmbLocationId(social._id);
          cache.gmb = {
            socialId,
            accessToken: social.accessToken,
            refreshToken: social.refreshToken || undefined,
            locationId,
            accountId: social.socialAccountId
          };
          break;
        }

        case Provider.SHOPIFY:
        case Provider.SQUARE:
          break;

        default:
          break;
      }
    }

    enrichTokensFromRuntime(userId, cache);
    getLocalIntegrationsCache<UserIntegrationCache>().set(cacheKey(userId), cache, ttlMs());

    logger.info('[USER_INTEGRATIONS] Cached', {
      userId,
      hasInstagram: Boolean(cache.instagram),
      hasGmb: Boolean(cache.gmb),
      posPlatform: cache.pos?.platform ?? null
    });

    return cache;
  } catch (err: unknown) {
    logger.error('[USER_INTEGRATIONS] cache build failed', {
      userId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

export async function invalidateUserIntegrations(userId: string): Promise<void> {
  getLocalIntegrationsCache().del(cacheKey(userId));
}

/** Read cache; rebuild from Mongo on miss. Returns null if build fails. */
export async function getUserIntegrations(userId: string): Promise<UserIntegrationCache | null> {
  const local = getLocalIntegrationsCache<UserIntegrationCache>();
  const hit = local.get(cacheKey(userId));
  if (hit) {
    return enrichTokensFromRuntime(userId, hit);
  }

  return cacheUserIntegrations(userId);
}

/**
 * After social.disconnected: drop one provider from cache without full Mongo rebuild,
 * or invalidate entire cache when provider omitted.
 */
export async function applySocialDisconnected(
  userId: string,
  provider?: Provider
): Promise<UserIntegrationCache | null> {
  if (!provider) {
    await invalidateUserIntegrations(userId);
    return cacheUserIntegrations(userId);
  }

  const existing = await getUserIntegrations(userId);
  if (!existing) return null;

  switch (provider) {
    case Provider.INSTAGRAM:
      delete existing.instagram;
      break;
    case Provider.GOOGLE_BUSINESS:
      delete existing.gmb;
      break;
        case Provider.SHOPIFY:
        case Provider.SQUARE:
          break;
    default:
      break;
  }

  existing.updatedAt = new Date().toISOString();

  getLocalIntegrationsCache<UserIntegrationCache>().set(cacheKey(userId), existing, ttlMs());

  return existing;
}
