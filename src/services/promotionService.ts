import mongoose from 'mongoose';
import { Ad, AdStatus, AdType } from '../models/Ad';
import { getActiveDeviceCache } from './deviceService';
import { getRedisService } from './redisService';
import { logger } from '../utils/logger';

const PROMO_ACTIVE_KEY_PREFIX = 'promo:active:';
const PROMO_ROTATION_KEY_PREFIX = 'promo:rotation:';

export function getPromotionCacheTtlSec(): number {
  const n = Number(process.env.PROMOTION_CACHE_TTL_SEC);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3600;
}

export type CachedPromotion = {
  _id: string;
  name: string;
  templateData: Record<string, unknown>;
  campaignId?: string;
  createdAt: string;
};

export type PromotionScreenPayload = {
  platform: string;
  Offer: string;
  message: string;
  qrText: string;
};

export type PromotionFanoutDeps = {
  topicRoot: string;
  publishForDevice: (deviceId: string, topicRoot: string) => Promise<void>;
};

function promoActiveKey(userId: string): string {
  return `${PROMO_ACTIVE_KEY_PREFIX}${userId}`;
}

function promoRotationKey(deviceId: string): string {
  return `${PROMO_ROTATION_KEY_PREFIX}${deviceId}`;
}

export function buildPromotionPayload(
  tplData: Record<string, unknown>,
  campaignId?: string
): PromotionScreenPayload {
  const claimUrl = campaignId
    ? `https://statsnapp.vercel.app/claim/${campaignId}`
    : undefined;

  const qrText =
    (typeof tplData.qrText === 'string' && tplData.qrText.trim() ? tplData.qrText.trim() : undefined) ??
    claimUrl ??
    (typeof tplData.url === 'string' && tplData.url.trim() ? tplData.url.trim() : undefined) ??
    'https://promo.link/coldbrew';

  return {
    platform: (typeof tplData.provider === 'string' && tplData.provider.trim()
      ? tplData.provider.trim()
      : 'shopify') as string,
    Offer: (typeof tplData.Offer === 'string'
      ? tplData.Offer
      : typeof tplData.offer === 'string'
        ? tplData.offer
        : '20%') as string,
    message: (typeof tplData.message === 'string'
      ? tplData.message
      : typeof tplData.textContent === 'string'
        ? tplData.textContent
        : 'Cold Brew') as string,
    qrText
  };
}

async function queryRunningPromotions(userId: string): Promise<CachedPromotion[]> {
  const userOid = new mongoose.Types.ObjectId(userId);
  const promos = await Ad.find({
    userId: userOid,
    type: AdType.PROMOTION,
    status: AdStatus.RUNNING
  })
    .sort({ createdAt: -1 })
    .limit(3)
    .lean();

  return promos.map((p) => ({
    _id: String(p._id),
    name: p.name,
    templateData: (p.templateData || {}) as Record<string, unknown>,
    campaignId: p.campaignId ? String(p.campaignId) : undefined,
    createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : String(p.createdAt)
  }));
}

export async function getActivePromotions(userId: string): Promise<CachedPromotion[]> {
  const redis = getRedisService();
  const key = promoActiveKey(userId);

  if (redis?.isRedisConnected()) {
    try {
      const cached = await redis.getClient().get(key);
      if (cached) {
        const parsed = JSON.parse(cached) as CachedPromotion[];
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (err: unknown) {
      logger.debug('[PROMO_CACHE] Redis read failed — querying Mongo', {
        userId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const dto = await queryRunningPromotions(userId);

  if (redis?.isRedisConnected()) {
    try {
      await redis.getClient().set(key, JSON.stringify(dto), { EX: getPromotionCacheTtlSec() });
    } catch {
      /* best-effort cache write */
    }
  }

  return dto;
}

export async function getNextPromotionIndex(deviceId: string, total: number): Promise<number> {
  if (total <= 0) return 0;
  if (total === 1) return 0;

  const redis = getRedisService();
  const key = promoRotationKey(deviceId);
  const ttl = getPromotionCacheTtlSec();

  if (!redis?.isRedisConnected()) {
    return 0;
  }

  try {
    const currentRaw = await redis.getClient().get(key);
    const index = currentRaw !== null && currentRaw !== '' ? Number(currentRaw) : 0;
    const safeIndex = Number.isFinite(index) ? Math.max(0, Math.min(total - 1, Math.floor(index))) : 0;
    const next = (safeIndex + 1) % total;
    await redis.getClient().set(key, String(next), { EX: ttl });
    return safeIndex;
  } catch (err: unknown) {
    logger.debug('[PROMO_ROTATION] Redis failed — using index 0', {
      deviceId,
      error: err instanceof Error ? err.message : String(err)
    });
    return 0;
  }
}

export async function resetRotationForUser(userId: string): Promise<void> {
  const redis = getRedisService();
  if (!redis?.isRedisConnected()) return;

  const devices = (await getActiveDeviceCache().getAllActive()).filter((d) => d.userId === userId);
  try {
    const client = redis.getClient();
    await Promise.all(devices.map((d) => client.del(promoRotationKey(d.deviceId))));
  } catch (err: unknown) {
    logger.debug('[PROMO_ROTATION] reset failed', {
      userId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

export async function invalidatePromotionCache(userId: string): Promise<void> {
  const redis = getRedisService();
  if (!redis?.isRedisConnected()) return;

  try {
    await redis.getClient().del(promoActiveKey(userId));
  } catch (err: unknown) {
    logger.warn('[PROMO_CACHE] invalidate failed', {
      userId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

export async function invalidateAndFanout(
  userId: string,
  deps: PromotionFanoutDeps
): Promise<{ invalidated: boolean; devicesNotified: number }> {
  await invalidatePromotionCache(userId);
  await resetRotationForUser(userId);

  const devices = (await getActiveDeviceCache().getAllActive()).filter((d) => d.userId === userId);

  for (const device of devices) {
    try {
      await deps.publishForDevice(device.deviceId, deps.topicRoot);
    } catch (err: unknown) {
      logger.warn('[PROMO_FANOUT] publish failed for device', {
        userId,
        deviceId: device.deviceId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  logger.info('[PROMO_FANOUT] Invalidated cache and notified devices', {
    userId,
    devicesNotified: devices.length
  });

  return { invalidated: true, devicesNotified: devices.length };
}
