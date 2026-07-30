import mongoose from 'mongoose';
import { Ad, AdType, AdStatus, type IAd } from '../models/Ad';
import type { PromotionScreenPayload } from './promotionService';
import { getLocalCanvasActiveCache } from './localCaches';

const CANVAS_ACTIVE_KEY_PREFIX = 'canvas:active:';

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
  const ttlMs = getCanvasCacheTtlSec() * 1000;
  const cache = getLocalCanvasActiveCache<CachedBrandCanvasDto>();
  const local = cache.get(canvasActiveKey(userId));
  if (local) {
    return local as unknown as IAd;
  }

  const ad = await getRunningBrandCanvasAd(userId);
  if (!ad) return null;

  const dto = toCachedDto(ad);
  cache.set(canvasActiveKey(userId), dto, ttlMs);

  return ad;
}

export async function invalidateCanvasCache(userId: string): Promise<void> {
  getLocalCanvasActiveCache().del(canvasActiveKey(userId));
}
