import { OAuth2Client } from 'google-auth-library';
import { Device } from '../../models/Device';
import { Social, Provider } from '../../models/Social';
import { GoogleBusinessProfile } from '../../models/GoogleBusinessProfile';
import { GoogleBusinessLocation } from '../../models/GoogleBusinessLocation';
import { getValidOAuth2Client } from '../../services/googleBusiness/googleBusinessOAuth';
import type { WebhookConfig } from '../../config/webhookConfig';
import { logger } from '../../utils/logger';
import { gmb, resolveGmbAccountResourceName } from './integrations';
import { setGmbReviewCount } from '../../webhooks/gmbReviewCache';
import type { DeviceGmbContext } from './resolveDeviceGmb';

type GmbApiAuth = Parameters<typeof gmb.listLocations>[0];

function gmbApiErrorMeta(err: unknown): Record<string, unknown> {
  const e = err as {
    code?: number | string;
    message?: string;
    response?: { status?: number; data?: unknown };
  };
  return {
    code: e?.code,
    status: e?.response?.status,
    message: e?.message ?? String(err),
    body: e?.response?.data
  };
}

/** ponytail: access-token only; no refresh without OAuth app creds. */
function createAccessTokenOAuthClient(accessToken: string): GmbApiAuth {
  const client = new OAuth2Client();
  client.setCredentials({ access_token: accessToken });
  return client as unknown as GmbApiAuth;
}

async function getGmbApiAuth(
  userId: string,
  social: { accessToken: string; refreshToken?: string | null },
  webhookConfig: WebhookConfig
): Promise<GmbApiAuth | null> {
  const oauth = await getValidOAuth2Client(userId, webhookConfig);
  if (oauth) {
    return oauth as unknown as GmbApiAuth;
  }

  const clientId = webhookConfig.googleBusinessClientId;
  const clientSecret = webhookConfig.googleBusinessClientSecret;
  if (clientId && clientSecret && social.accessToken.trim()) {
    return gmb.createGmbOAuth2Client(
      {
        appBaseUrl: webhookConfig.publicBaseUrl || 'http://localhost:3000',
        instagram: { clientId: 'unused', clientSecret: 'unused', redirectPath: '/' },
        googleBusiness: {
          clientId,
          clientSecret,
          redirectPath: '/api/social/google-business'
        },
        webhooks: { gmbPubsub: { audience: 'local', pubsubTopic: 'local', skipVerify: true } }
      },
      social.accessToken,
      social.refreshToken ?? null
    );
  }

  if (social.accessToken.trim()) {
    logger.info('[GMB_SYNC] Using stored access token (no OAuth app creds on server)', { userId });
    return createAccessTokenOAuthClient(social.accessToken);
  }

  return null;
}

function locationCacheKeyFromResourceName(resourceName: string): string {
  const normalized = resourceName.replace(/^\//, '');
  const match = normalized.match(/locations\/([^/]+)$/);
  return match ? match[1] : normalized;
}

async function tryKnownLocation(
  auth: GmbApiAuth,
  accountId: string,
  locationId?: string
): Promise<{ resourceName: string; title?: string } | null> {
  if (!locationId?.trim()) return null;

  const resourceName = gmb.normalizeToGmbLocationResourceName(locationId, accountId);
  if (!resourceName) return null;

  try {
    const loc = await gmb.getBusinessInformationLocation(auth, resourceName);
    if (loc?.name) {
      return { resourceName: loc.name, title: loc.title ?? undefined };
    }
  } catch (err: unknown) {
    logger.debug('[GMB_SYNC] known locationId lookup failed', {
      locationId,
      accountId,
      error: gmbApiErrorMeta(err)
    });
  }
  return null;
}

async function pickAccessibleLocation(
  auth: GmbApiAuth,
  accountId: string,
  knownLocationId?: string
): Promise<{ resourceName: string; title?: string } | null> {
  const fromKnown = await tryKnownLocation(auth, accountId, knownLocationId);
  if (fromKnown) return fromKnown;

  const accountCandidates = [
    accountId,
    resolveGmbAccountResourceName(accountId)
  ].filter((v, i, arr) => v && arr.indexOf(v) === i);

  for (const candidate of accountCandidates) {
    try {
      const locations = await gmb.listLocations(auth, candidate);
      const first = locations.find((loc) => typeof loc.name === 'string' && loc.name.length > 0);
      if (first?.name) {
        return { resourceName: first.name, title: first.title ?? undefined };
      }
    } catch (err: unknown) {
      const error = gmbApiErrorMeta(err);
      logger.warn('[GMB_SYNC] listLocations failed for account candidate', {
        candidate,
        error
      });
    }
  }

  try {
    const accounts = await gmb.listAllAccounts(auth);
    for (const account of accounts) {
      if (!account.name || accountCandidates.includes(account.name)) continue;
      try {
        const locations = await gmb.listLocations(auth, account.name);
        const first = locations.find((loc) => typeof loc.name === 'string' && loc.name.length > 0);
        if (first?.name) {
          return { resourceName: first.name, title: first.title ?? undefined };
        }
      } catch (err: unknown) {
        const error = gmbApiErrorMeta(err);
        logger.warn('[GMB_SYNC] fallback listLocations failed', {
          candidate: account.name,
          error
        });
      }
    }
  } catch (err: unknown) {
    logger.warn('[GMB_SYNC] listAllAccounts failed', {
      error: gmbApiErrorMeta(err)
    });
  }

  return null;
}

/**
 * Fetch GMB location stats from GBP API, upsert Mongo location row, seed review cache.
 * Used on device connect when Social+Profile exist but GoogleBusinessLocation is missing.
 */
export async function syncGmbLocationForDevice(
  deviceId: string,
  webhookConfig: WebhookConfig,
  opts?: { knownLocationId?: string }
): Promise<DeviceGmbContext | null> {
  const deviceDoc = await Device.findOne({ clientId: deviceId }).select({ businessId: 1 }).lean();
  if (!deviceDoc?.businessId) return null;

  const businessId = String(deviceDoc.businessId);
  const social = await Social.findOne({
    businessId: deviceDoc.businessId,
    provider: Provider.GOOGLE_BUSINESS
  }).lean();
  if (!social) return null;

  const profile = await GoogleBusinessProfile.findOne({ socialId: social._id }).lean();
  if (!profile) return null;

  const auth = await getGmbApiAuth(businessId, social, webhookConfig);
  if (!auth) {
    logger.warn('[GMB_SYNC] No GBP auth — cannot fetch initial GMB snapshot', {
      deviceId,
      businessId,
      hasAccessToken: Boolean(social.accessToken?.trim()),
      hasOAuthAppCreds: Boolean(
        webhookConfig.googleBusinessClientId && webhookConfig.googleBusinessClientSecret
      )
    });
    return null;
  }
  const picked = await pickAccessibleLocation(auth, profile.accountId, opts?.knownLocationId);
  if (!picked) {
    let accountType: string | undefined;
    try {
      const accounts = await gmb.listAllAccounts(auth);
      accountType = accounts.find((a) => a.name === profile.accountId)?.type ?? undefined;
    } catch {
      /* optional metadata */
    }
    logger.warn('[GMB_SYNC] No accessible GBP locations for account', {
      deviceId,
      businessId,
      accountId: profile.accountId,
      accountType,
      knownLocationId: opts?.knownLocationId ?? null,
      hint:
        'Google returned 0 locations. Verify a business location exists in Google Business Profile and is linked to this account.'
    });
    return null;
  }

  const summary = await gmb.fetchGmbLocationSummary(auth, picked.resourceName);
  if (!summary) {
    logger.warn('[GMB_SYNC] fetchGmbLocationSummary returned null', {
      deviceId,
      businessId,
      locationResourceName: picked.resourceName
    });
    return null;
  }

  const locationDoc = await GoogleBusinessLocation.findOneAndUpdate(
    { locationId: picked.resourceName },
    {
      $set: {
        profileId: profile._id,
        locationId: picked.resourceName,
        locationName: picked.title,
        totalReviewCount: summary.totalReviewCount,
        averageRating: summary.averageRating
      }
    },
    { upsert: true, new: true }
  ).lean();

  await setGmbReviewCount(
    locationCacheKeyFromResourceName(picked.resourceName),
    summary.totalReviewCount
  );

  logger.info('[GMB_SYNC] Location synced from GBP API on connect', {
    deviceId,
    businessId,
    locationId: picked.resourceName,
    verifiedReviewCount: summary.totalReviewCount,
    averageRating: summary.averageRating
  });
  return {
    businessId,
    deviceId,
    verifiedReviewCount: locationDoc?.totalReviewCount ?? summary.totalReviewCount,
    averageRating: locationDoc?.averageRating ?? summary.averageRating,
    locationName: locationDoc?.locationName ?? picked.title
  };
}
