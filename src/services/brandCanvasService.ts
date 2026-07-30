import mongoose from 'mongoose';
import { Ad, AdType, AdStatus, type IAd } from '../models/Ad';
import type { PromotionScreenPayload } from './promotionService';
import { getRedisService } from './redisService';
import { logger } from '../utils/logger';

const CANVAS_ACTIVE_KEY_PREFIX = 'canvas:active:';

const canvasLocalCache = new Map<string, { data: CachedBrandCanvasDto; expiresAt: number }>();

function clearCanvasLocalEntry(userId: string): void {
  canvasLocalCache.delete(userId);
}

export type CachedBrandCanvasDto = {
  _id: string;
  userId: string;
  name: string;
  creativeUrl: string;
  templateData: Record<string, unknown>;
  status: string;
  updatedAt: string;
};

export function getCanvasCacheTtlSec(): number {
  const n = Number(process.env.CANVAS_CACHE_TTL_SEC || process.env.PROMOTION_CACHE_TTL_SEC);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3600;
}

function canvasActiveKey(userId: string): string {
  return `${CANVAS_ACTIVE_KEY_PREFIX}${userId}`;
}

function toCachedDto(ad: IAd): CachedBrandCanvasDto {
  return {
    _id: String(ad._id),
    userId: String(ad.userId),
    name: ad.name,
    creativeUrl: ad.creativeUrl,
    templateData: (ad.templateData || {}) as Record<string, unknown>,
    status: ad.status,
    updatedAt: ad.updatedAt.toISOString()
  };
}

export async function getRunningBrandCanvasAd(userId: string): Promise<IAd | null> {
  if (!mongoose.Types.ObjectId.isValid(userId)) return null;

  const userOid = new mongoose.Types.ObjectId(userId);
  const ad = await Ad.findOne({
    userId: userOid,
    type: AdType.BRAND_CANVAS,
    status: AdStatus.RUNNING
  })
    .sort({ updatedAt: -1 })
    .lean();

  return ad as IAd | null;
}

export function buildBrandCanvasPayload(
  ad: IAd | CachedBrandCanvasDto
): PromotionScreenPayload {
  const templateData = (ad.templateData || {}) as Record<string, unknown>;
  const name = ad.name || '';
  const creativeUrl = ad.creativeUrl || '';

  const Offer =
    (typeof templateData.Offer === 'string' && templateData.Offer) ||
    (typeof templateData.offer === 'string' && templateData.offer) ||
    '';
  const message =
    (typeof templateData.message === 'string' && templateData.message) || name;
  const qrText =
    (typeof templateData.qrText === 'string' && templateData.qrText) ||
    (typeof templateData.qrUrl === 'string' && templateData.qrUrl) ||
    creativeUrl;

  return {
    platform: 'brand_canvas',
    Offer,
    message,
    qrText,
    creativeUrl,
    templateData
  };
}

export async function getCachedBrandCanvasAd(userId: string): Promise<IAd | null> {
  const ttlSec = getCanvasCacheTtlSec();
  const local = canvasLocalCache.get(userId);
  if (local && local.expiresAt > Date.now()) {
    return local.data as unknown as IAd;
  }
  if (local) clearCanvasLocalEntry(userId);

  const redis = getRedisService();
  const key = canvasActiveKey(userId);

  if (redis?.isRedisConnected()) {
    try {
      const cached = await redis.getClient().get(key);
      if (cached) {
        const parsed = JSON.parse(cached) as CachedBrandCanvasDto;
        canvasLocalCache.set(userId, { data: parsed, expiresAt: Date.now() + ttlSec * 1000 });
        return parsed as unknown as IAd;
      }
    } catch {
      /* fall through to Mongo */
    }
  }

  const ad = await getRunningBrandCanvasAd(userId);
  if (!ad) return null;

  const dto = toCachedDto(ad);
  canvasLocalCache.set(userId, { data: dto, expiresAt: Date.now() + ttlSec * 1000 });

  if (redis?.isRedisConnected()) {
    try {
      await redis
        .getClient()
        .set(key, JSON.stringify(dto), { EX: ttlSec });
    } catch {
      /* best-effort */
    }
  }

  return ad;
}

export async function invalidateCanvasCache(userId: string): Promise<void> {
  clearCanvasLocalEntry(userId);
  const redis = getRedisService();
  if (!redis?.isRedisConnected()) return;

  try {
    await redis.getClient().del(canvasActiveKey(userId));
  } catch (err: unknown) {
    logger.warn('[CANVAS_CACHE] invalidate failed', {
      userId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
