import mongoose from 'mongoose';
import { ig, isAccessTokenExpired } from './integrations';
import { Social, Provider } from '../../models/Social';
import { getRedisService } from '../../services/redisService';
import { getActiveDeviceCache } from '../../services/deviceService';
import { getIgDeviceRuntimeCache } from '../../services/igDeviceRuntimeCache';
import { REDIS_KEYS } from '../../constants/redisKeys';
import { logger } from '../../utils/logger';

async function updateDeviceTokenInRedis(deviceId: string, newToken: string, newExp: string): Promise<void> {
  getIgDeviceRuntimeCache().set(deviceId, { igAccessToken: newToken });
  getIgDeviceRuntimeCache().markDirty(deviceId, 'ig_accessToken');

  const redisSvc = getRedisService();
  if (!redisSvc?.isRedisConnected()) return;
  const key = REDIS_KEYS.deviceHash(deviceId);
  try {
    const client = redisSvc.getClient();
    const keyType = await client.type(key);
    if (keyType === 'hash' || keyType === 'none') {
      await client.hSet(key, {
        ig_accessToken: newToken,
        tokenExpiresAt: newExp
      });
      await client.expire(key, 7 * 24 * 3600);
      return;
    }
    const raw = await client.get(key);
    const base =
      raw && typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : {};
    await client.del(key);
    await client.hSet(key, {
      ...Object.fromEntries(
        Object.entries(base).map(([k, v]) => [k, String(v ?? '')])
      ),
      ig_accessToken: newToken,
      accessToken: newToken,
      tokenExpiresAt: newExp
    });
    await client.expire(key, 7 * 24 * 3600);
  } catch (err: unknown) {
    logger.debug('[IG_TOKEN] Failed to update Redis device meta', {
      deviceId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

export type InstagramTokenContext = {
  accessToken: string;
  tokenExp: string;
  tokenCreatedAt: Date | null;
  socialId?: string;
};

/** Load Instagram token expiry fields from Mongo for a user. */
export async function loadInstagramTokenContextForUser(
  userId: string
): Promise<InstagramTokenContext | null> {
  if (!mongoose.Types.ObjectId.isValid(userId)) return null;
  try {
    const ig = await Social.findOne({
      userId: new mongoose.Types.ObjectId(userId),
      provider: Provider.INSTAGRAM
    })
      .sort({ updatedAt: -1 })
      .select({ accessToken: 1, tokenExp: 1, tokenCreatedAt: 1 })
      .lean();
    if (!ig?.accessToken) return null;
    return {
      accessToken: ig.accessToken,
      tokenExp: ig.tokenExp,
      tokenCreatedAt: ig.tokenCreatedAt ?? null,
      socialId: String(ig._id)
    };
  } catch (err: unknown) {
    logger.debug('[IG_TOKEN] Failed to load Social token context', {
      userId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

/**
 * Refresh long-lived Instagram token when expired; persist to Mongo Social + Redis device meta.
 */
export async function ensureFreshInstagramAccessToken(opts: {
  deviceId: string;
  accessToken: string;
  userId?: string;
  tokenExp?: string;
  tokenCreatedAt?: Date | null;
}): Promise<string> {
  let tokenExp = opts.tokenExp;
  let tokenCreatedAt = opts.tokenCreatedAt ?? null;
  let accessToken = opts.accessToken;

  if (opts.userId && (!tokenExp || tokenCreatedAt === null)) {
    const ctx = await loadInstagramTokenContextForUser(opts.userId);
    if (ctx) {
      tokenExp = tokenExp ?? ctx.tokenExp;
      tokenCreatedAt = tokenCreatedAt ?? ctx.tokenCreatedAt;
      accessToken = ctx.accessToken || accessToken;
    }
  }

  const record = {
    tokenExp: tokenExp ?? '5184000',
    tokenCreatedAt
  };

  if (!isAccessTokenExpired(record)) {
    return accessToken;
  }

  logger.info('[IG_TOKEN] Access token expired — refreshing', { deviceId: opts.deviceId, userId: opts.userId });

  const refreshed = await ig.refreshLongLivedToken(accessToken);
  if (!refreshed?.access_token) {
    logger.warn('[IG_TOKEN] refreshLongLivedToken returned no token', { deviceId: opts.deviceId });
    return accessToken;
  }

  const newToken = refreshed.access_token;
  const newExp = String(refreshed.expires_in ?? record.tokenExp);
  const now = new Date();

  if (opts.userId && mongoose.Types.ObjectId.isValid(opts.userId)) {
    try {
      await Social.updateOne(
        { userId: new mongoose.Types.ObjectId(opts.userId), provider: Provider.INSTAGRAM },
        {
          $set: {
            accessToken: newToken,
            tokenExp: newExp,
            tokenCreatedAt: now,
            lastSyncedAt: now
          }
        }
      );
    } catch (err: unknown) {
      logger.warn('[IG_TOKEN] Failed to persist refreshed token to Social', {
        deviceId: opts.deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  await updateDeviceTokenInRedis(opts.deviceId, newToken, newExp);

  try {
    const ad = await getActiveDeviceCache().getActive(opts.deviceId);
    if (ad) {
      await getActiveDeviceCache().setActive({
        ...ad,
        accessToken: newToken,
        lastSeen: Date.now()
      });
    }
  } catch {
    /* active cache is best-effort */
  }

  return newToken;
}
